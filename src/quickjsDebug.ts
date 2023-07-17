import * as vscode from "vscode";
import { Server, Socket, createConnection } from "net";
import { basename } from "path";
import { MappedPosition } from "source-map";
import {
  InitializedEvent,
  Logger,
  logger,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
  ThreadEvent,
} from "@vscode/debugadapter";
import { DebugProtocol } from "@vscode/debugprotocol";
import { SourcemapArguments } from "./sourcemapArguments";
import { SourcemapSession } from "./sourcemapSession";
import * as WebSocketStream from "@httptoolkit/websocket-stream";
import * as WebSocket from "ws";
import { configFile, getApiBaseUrl } from "./util";
const fetch = require("node-fetch");

const Parser = require("stream-parser");
const Transform = require("stream").Transform;
const { Subject } = require("await-notify");

interface CommonArguments extends SourcemapArguments {
  pname: string;
  pid: string;
  // args?: string[];
  // cwd?: string;
  // runtimeExecutable: string;
  // mode: string;
  // address: string;
  // port: number;
  // console?: ConsoleType;
  trace?: boolean;
}

/**
 * Messages from the qjs binary are in big endian length prefix json payloads.
 * The protocol is roughly just the JSON stringification of the requests.
 * Responses are intercepted to translate references into thread scoped references.
 */
class MessageParser extends Transform {
  constructor() {
    super();
    this._bytes(9, this.onLength);
  }

  private onLength(buffer: Buffer) {
    let length = parseInt(buffer.toString(), 16);
    this.emit("length", length);
    this._bytes(length, this.onMessage);
  }

  private onMessage(buffer: Buffer) {
    let json = JSON.parse(buffer.toString());
    this.emit("message", json);
    this._bytes(9, this.onLength);
  }
}
Parser(MessageParser.prototype);

interface PendingResponse {
  resolve: Function;
  reject: Function;
}

type ApiTunnel = WebSocketStream.WebSocketDuplex;

// class ApiTunnel extends Duplex {
// 	ws: WebSocket;
// 	buf: String;
// 	constructor(url: string) {
// 		super();
// 		this.ws = new WebSocket(url);
// 		this.ws.onmessage = (event) => {
// 			// Append to buf
// 			this.buf += event.data;
// 		};
// 	}

// 	_write(chunk, encoding, callback) {
// 		console.log('WRITING TO API TUNNEL:', chunk.toString());
// 		this.ws.send(chunk.toString());
// 		// TODO: send chunk to API
// 		callback();
// 	}

// 	_read(size) {
// 		console.log('READING FROM API TUNNEL:', size);
// 		// TODO: read from API
// 		const data = "";
// 		this.push("");
// 	}

// }

export class QuickJSDebugSession extends SourcemapSession {
  private _server?: Server;
  private _isTerminated: boolean;
  private _threads = new Set<number>();
  private _connection?: ApiTunnel;
  private _requests = new Map<number, PendingResponse>();
  private _queuedEvents: { thread: number; event: any }[] = [];
  // contains a list of real source files and their source mapped breakpoints.
  // ie: file1.ts -> webpack.main.js:59
  //     file2.ts -> webpack.main.js:555
  // when sending breakpoint messages, perform the mapping, note which mapped files changed,
  // then filter the breakpoint values for those touched files.
  // sending only the mapped breakpoints from file1.ts would clobber existing
  // breakpoints from file2.ts, as they both map to webpack.main.js.
  private _breakpoints = new Map<string, MappedPosition[]>();
  private _stopOnException = false;
  private _stackFrames = new Map<number, number>();
  private _variables = new Map<number, number>();
  private _commonArgs: CommonArguments;
  private _argsSubject = new Subject();
  private _argsReady = (async () => {
    await this._argsSubject.wait();
  })();

  public constructor() {
    super("membrane-debug.txt");

    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    args: DebugProtocol.InitializeRequestArguments
  ): void {
    // build and return the capabilities of this debug adapter:
    response.body = response.body || {};

    // make VS Code to use 'evaluate' when hovering over source
    response.body.supportsEvaluateForHovers = true;
    response.body.exceptionBreakpointFilters = [
      {
        label: "All Exceptions",
        filter: "exceptions",
      },
    ];

    // make VS Code to support data breakpoints
    // response.body.supportsDataBreakpoints = true;

    // make VS Code to support completion in REPL
    response.body.supportsCompletionsRequest = true;
    response.body.completionTriggerCharacters = [".", "["];

    // make VS Code to send cancelRequests
    // response.body.supportsCancelRequest = true;

    // make VS Code send the breakpointLocations request
    // response.body.supportsBreakpointLocationsRequest = true;

    response.body.supportsConfigurationDoneRequest = true;

    response.body.supportsTerminateRequest = true;

    this.sendResponse(response);

    this.sendEvent(new InitializedEvent());
  }

  private handleEvent(thread: number, event: any) {
    logger.warn(`EVENT (${event.type})`);
    if (this._requests.size !== 0) {
      logger.warn("Queueing event");
      this._queuedEvents.push({ thread, event });
      return;
    }
    if (event.type === "StoppedEvent") {
      if (event.reason !== "entry")
        this.sendEvent(new StoppedEvent(event.reason, thread));
    } else if (event.type === "terminated") {
      this._terminated("remote terminated");
    } else if (event.type === "ThreadEvent") {
      const threadEvent = new ThreadEvent(event.reason, thread);
      if (threadEvent.body.reason === "new") this._threads.add(thread);
      else if (threadEvent.body.reason === "exited")
        this._threads.delete(thread);
      this.sendEvent(threadEvent);
    }
  }

  private handleResponse(json: any) {
    let request_seq: number = json.request_seq;
    let pending = this._requests.get(request_seq);
    if (!pending) {
      this.log(`request not found: ${request_seq}`);
      return;
    }
    if (json.error) pending.reject(new Error(json.error));
    else pending.resolve(json.body);
    this._requests.delete(request_seq);

    if (this._requests.size === 0) {
      logger.warn(
        `No more pending requests. Sending events: ${this._queuedEvents.length}`
      );
      for (let queued of this._queuedEvents) {
        this.handleEvent(queued.thread, queued.event);
      }
      this._queuedEvents.length = 0;
    }
  }

  private async newSession() {
    let files = new Set<string>();
    for (let bps of this._breakpoints.values()) {
      for (let bp of bps) {
        files.add(bp.source);
      }
    }
    for (let file of files) {
      await this.sendBreakpointMessage(file);
    }

    this.sendThreadMessage({
      type: "stopOnException",
      stopOnException: this._stopOnException,
    });

    this.sendThreadMessage({ type: "continue" });
  }

  private onSocket(socket: ApiTunnel) {
    this.closeConnection();
    this._connection = socket;
    this.newSession();

    let parser = new MessageParser();
    parser.on("message", (json) => {
      // the very first message will include the thread id, as it will be a stopped event.
      this.log("MESSAGE: " + JSON.stringify(json));
      if (json.type === "event") {
        const thread = json.event.thread;
        if (!this._threads.has(thread)) {
          this._threads.add(thread);
          this.sendEvent(new ThreadEvent("new", thread));
          this.emit("quickjs-thread");
        }
        this.log(
          `received message (thread ${thread}): ${JSON.stringify(json)}`
        );
        Promise.resolve().then(() => this.handleEvent(thread, json.event));
      } else if (json.type === "response") {
        this.handleResponse(json);
      } else {
        this.log(`unknown message ${json.type}`);
      }
    });

    socket.pipe(parser as any);
    socket.on("error", (e) => this._terminated(e.toString()));
    socket.on("close", () => this._terminated("close"));
  }

  protected disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    args: DebugProtocol.DisconnectArguments,
    request?: DebugProtocol.Request
  ): void {
    this.closeServer();
    this.closeConnection();
    this.sendResponse(response);
  }

  protected async attachRequest2(
    response: DebugProtocol.AttachResponse,
    args: DebugProtocol.AttachRequestArguments,
    request?: DebugProtocol.Request
  ) {
    let socket: Socket | undefined = undefined;
    this._commonArgs = { ...(args as any) };
    this._argsSubject.notify();

    logger.setup(true ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, true);
    for (let attempt = 0; attempt < 10; attempt++) {
      this.log("CONNECTING TO: " + "ox");
      this.log("CONNECTING TO: " + "ox");
      try {
        socket = await new Promise<Socket>((resolve, reject) => {
          let socket = createConnection(8888, "ox");
          socket.on("connect", () => {
            this.log("CONNECTED TO: " + "ox");
            socket.removeAllListeners();
            resolve(socket);
          });

          socket.on("close", reject);
          socket.on("error", reject);
        });
        break;
      } catch (e) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (!socket) {
      const address = "ox";
      throw new Error(`Cannot launch connect (${address}:${8888}).`);
    }

    this.onSocket(socket as any);
    this.sendResponse(response);
  }

  protected async attachRequest(
    response: DebugProtocol.AttachResponse,
    args: DebugProtocol.AttachRequestArguments,
    request?: DebugProtocol.Request
  ) {
    // make sure to 'Stop' the buffered logging if 'trace' is not set

    this.log(`Attaching debugger to Membrane`);
    this._commonArgs = { ...(args as any) };
    logger.setup(
      this._commonArgs.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop,
      false
    );
    const apiUrl = getApiBaseUrl();

    const { access_token } = await configFile();
    const { programs } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Fetching programs...",
        cancellable: false,
      },
      async (_progress, _token) => {
        let response;
        try {
          response = await fetch(`${apiUrl}/ps`, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${access_token}`,
            },
          });
        } catch (e) {
          vscode.window.showErrorMessage("Failed to fetch programs" + e);
          throw e;
        }
        const json = await response.json();
        return json;
      }
    );
    const program = await vscode.window.showQuickPick(
      programs.map((p) => `${p.name} (${p.pid})`),
      {
        placeHolder: "Select a program to debug",
      }
    );
    if (!program) {
      this.sendErrorResponse(
        response,
        2028,
        `No program selected. Canceling debug session.`
      );
      return;
    }
    this.log("Attaching debugger to program: " + program);
    const matches = program.match(/^(.+) \((\d+)\)/)!;
    const pname = matches[1];
    const pid = matches[2];
    this._commonArgs.pname = pname;
    this._commonArgs.pid = pid;

    // Fetch source_map using the program_details endpoint
    const { source_map } = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Fetching source code...",
        cancellable: false,
      },
      async (_progress, _token) => {
        let response;
        try {
          response = await fetch(
            `${apiUrl}/program_details/${pid}?source_map=true`,
            {
              method: "GET",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${access_token}`,
              },
            }
          );
        } catch (e) {
          vscode.window.showErrorMessage("Failed to fetch source code" + e);
          throw e;
        }
        const json = await response.json();
        return json;
      }
    );
    await this.loadSourceMap(source_map);

    // Important that we notify this after loading the source map
    this._argsSubject.notify();

    // Connect to Membrane's websocket
    const wsUrl = `${apiUrl.replace(/^http/, "ws")}/debugger/ws?pid=${
      this._commonArgs.pname
    }`;
    this.log(`Connecting to ${wsUrl}`);
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });
    const tunnel = WebSocketStream(ws);
    this.onSocket(tunnel);

    this.sendResponse(response);
  }

  getProgramName(): string {
    return this._commonArgs.pname;
  }

  async getArguments(): Promise<SourcemapArguments> {
    await this._argsReady;
    return this._commonArgs;
  }

  public log(message: string) {
    this.sendEvent(new OutputEvent(message + "\n", "console"));
  }

  private _terminated(reason: string): void {
    this.log(`Debug Session Ended: ${reason}`);
    this.closeServer();
    this.closeConnection();

    if (!this._isTerminated) {
      this._isTerminated = true;
      this.sendEvent(new TerminatedEvent());
    }
  }

  private async closeServer() {
    if (this._server) {
      this._server.close();
      this._server = undefined;
    }
  }
  private async closeConnection() {
    if (this._connection) this._connection.destroy();
    this._connection = undefined;
    this._threads.clear();
  }

  protected async terminateRequest(
    response: DebugProtocol.TerminateResponse,
    args: DebugProtocol.TerminateArguments,
    request?: DebugProtocol.Request
  ) {
    this.closeServer();
    this.sendResponse(response);
  }

  private async sendBreakpointMessage(file: string) {
    const breakpoints: DebugProtocol.SourceBreakpoint[] = [];

    for (let bpList of this._breakpoints.values()) {
      for (let bp of bpList.filter((bp) => bp.source === file)) {
        breakpoints.push({
          line: bp.line,
          column: bp.column,
        });
      }
    }
    const envelope = {
      type: "breakpoints",
      breakpoints: {
        path: file,
        breakpoints: breakpoints.length ? breakpoints : undefined,
      },
    };
    this.sendThreadMessage(envelope);
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ) {
    response.body = {
      breakpoints: [],
    };

    this.log(`setBreakPointsRequest: ${JSON.stringify(args)}`);

    if (!args.source.path) {
      this.sendResponse(response);
      return;
    }

    // before clobbering the map entry, note which files currently have mapped breakpoints.
    const dirtySources = new Set<string>();
    for (const existingBreakpoint of this._breakpoints.get(args.source.path) ||
      []) {
      dirtySources.add(existingBreakpoint.source);
    }

    // map the new breakpoints for a file, and mapped files that get touched.
    const bps = args.breakpoints || [];
    const mappedBreakpoints: MappedPosition[] = [];
    for (let bp of bps) {
      const mappedPositions = await this.translateFileLocationToRemote({
        source: args.source.path,
        column: bp.column || 0,
        line: bp.line,
      });

      for (let mapped of mappedPositions) {
        dirtySources.add(mapped.source);
        mappedBreakpoints.push(mapped);
      }
    }

    // update the entry for this file
    if (args.breakpoints) {
      this._breakpoints.set(args.source.path, mappedBreakpoints);
    } else {
      this._breakpoints.delete(args.source.path);
    }

    for (let file of dirtySources) {
      await this.sendBreakpointMessage(file);
    }
    this.sendResponse(response);
  }

  protected setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
    request?: DebugProtocol.Request
  ) {
    this.sendResponse(response);

    this._stopOnException = args.filters.length > 0;

    this.sendThreadMessage({
      type: "stopOnException",
      stopOnException: this._stopOnException,
    });
  }

  protected async threadsRequest(
    response: DebugProtocol.ThreadsResponse
  ): Promise<void> {
    if (this._threads.size === 0) {
      await new Promise((resolve, reject) => {
        this.once("quickjs-thread", () => {
          resolve(void 0);
        });
      });
    }
    response.body = {
      threads: [
        ...Array.from(this._threads.keys()).map(
          (thread) =>
            new Thread(
              thread,
              `${this._commonArgs.pname} (${this._commonArgs.pid})`
            )
        ),
      ],
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ) {
    const thread = args.threadId;
    const body = await this.sendThreadRequest(args.threadId, response, args);

    const stackFrames: StackFrame[] = [];
    for (const { id, name, filename, line, column } of body) {
      let mappedId = id + thread;
      this._stackFrames.set(mappedId, thread);
      this.log(
        `MAPING ${id} ${name} ${filename} ${line} ${column}: ${mappedId}`
      );

      try {
        const mappedLocation = await this.translateRemoteLocationToLocal({
          source: filename,
          line: line || 0,
          column: column || 0,
        });
        if (!mappedLocation.source) throw new Error("map failed");
        const source = new Source(
          basename(mappedLocation.source),
          this.convertClientPathToDebugger(mappedLocation.source)
        );
        stackFrames.push(
          new StackFrame(
            mappedId,
            name,
            source,
            mappedLocation.line,
            mappedLocation.column
          )
        );
      } catch (e) {
        stackFrames.push(
          new StackFrame(mappedId, name, filename, line, column)
        );
      }
    }

    const totalFrames = body.length;

    response.body = {
      stackFrames,
      totalFrames,
    };
    this.sendResponse(response);
  }

  protected async scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ) {
    const thread = this._stackFrames.get(args.frameId);
    if (!thread) {
      this.sendErrorResponse(response, 2030, "scopesRequest: thread not found");
      return;
    }
    args.frameId -= thread;
    const body = await this.sendThreadRequest(thread, response, args);
    const scopes = body.map(({ name, reference, expensive }) => {
      // todo: use counter mapping
      let mappedReference = reference + thread;
      this._variables.set(mappedReference, thread);
      return new Scope(name, mappedReference, expensive);
    });

    response.body = {
      scopes,
    };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
    request?: DebugProtocol.Request
  ) {
    const thread = this._variables.get(args.variablesReference);
    if (!thread) {
      this.sendErrorResponse(response, 2030, "scopesRequest: thread not found");
      return;
    }

    args.variablesReference -= thread;
    const body = await this.sendThreadRequest(thread, response, args);
    const variables = body.map(
      ({ name, value, type, variablesReference, indexedVariables }) => {
        // todo: use counter mapping
        variablesReference = variablesReference
          ? variablesReference + thread
          : 0;
        this._variables.set(variablesReference, thread);
        return { name, value, type, variablesReference, indexedVariables };
      }
    );

    response.body = {
      variables,
    };
    this.sendResponse(response);
  }

  private sendThreadMessage(envelope: any) {
    if (!this._connection) {
      this.log(`debug connection not avaiable`);
      return;
    }

    this.log(`sent: ${JSON.stringify(envelope)}`);

    let json = JSON.stringify(envelope);

    let jsonBuffer = Buffer.from(json);
    // length prefix is 8 hex followed by newline = 012345678\n
    // not efficient, but protocol is then human readable.
    // json = 1 line json + new line
    let messageLength = jsonBuffer.byteLength + 1;
    let length = "00000000" + messageLength.toString(16) + "\n";
    length = length.substr(length.length - 9);
    let lengthBuffer = Buffer.from(length);
    let newline = Buffer.from("\n");
    let buffer = Buffer.concat([lengthBuffer, jsonBuffer, newline]);
    this._connection.write(buffer);
  }

  private sendThreadRequest(
    thread: number,
    response: DebugProtocol.Response,
    args: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let request_seq = response.request_seq;
      // todo: don't actually need to cache this. can send across wire.
      this._requests.set(request_seq, {
        resolve,
        reject,
      });

      let envelope = {
        type: "request",
        request: {
          request_seq,
          command: response.command,
          args,
        },
      };

      this.sendThreadMessage(envelope);
    });
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ) {
    response.body = await this.sendThreadRequest(args.threadId, response, args);
    this.sendResponse(response);
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ) {
    logger.warn(`NEXT START`);
    response.body = await this.sendThreadRequest(args.threadId, response, args);
    this.sendResponse(response);
    logger.warn(`NEXT END`);
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments,
    request?: DebugProtocol.Request
  ) {
    response.body = await this.sendThreadRequest(args.threadId, response, args);
    this.sendResponse(response);
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments,
    request?: DebugProtocol.Request
  ) {
    response.body = await this.sendThreadRequest(args.threadId, response, args);
    this.sendResponse(response);
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ) {
    if (!args.frameId) {
      this.sendErrorResponse(
        response,
        2030,
        "scopesRequest: frameId not specified"
      );
      return;
    }
    let thread = this._stackFrames.get(args.frameId);
    if (!thread) {
      this.sendErrorResponse(response, 2030, "scopesRequest: thread not found");
      return;
    }
    args.frameId -= thread;

    const body = await this.sendThreadRequest(thread, response, args);
    let variablesReference = body.variablesReference;
    variablesReference = variablesReference ? variablesReference + thread : 0;
    this._variables.set(variablesReference, thread);
    body.variablesReference = variablesReference;

    response.body = body;
    this.sendResponse(response);
  }

  protected async pauseRequest(
    response: DebugProtocol.PauseResponse,
    args: DebugProtocol.PauseArguments,
    request?: DebugProtocol.Request
  ) {
    response.body = await this.sendThreadRequest(args.threadId, response, args);
    this.sendResponse(response);
  }

  protected async completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments
  ) {
    if (!args.frameId) {
      this.sendErrorResponse(
        response,
        2030,
        "completionsRequest: frameId not specified"
      );
      return;
    }
    let thread = this._stackFrames.get(args.frameId);
    if (!thread) {
      this.sendErrorResponse(
        response,
        2030,
        "completionsRequest: thread not found"
      );
      return;
    }
    args.frameId -= thread;

    let expression = args.text.substr(0, args.text.length - 1);
    if (!expression) {
      this.sendErrorResponse(
        response,
        2032,
        "no completion available for empty string"
      );
      return;
    }

    const evaluateArgs: DebugProtocol.EvaluateArguments = {
      frameId: args.frameId,
      expression,
    };
    response.command = "evaluate";

    let body = await this.sendThreadRequest(thread, response, evaluateArgs);
    if (!body.variablesReference) {
      this.sendErrorResponse(
        response,
        2032,
        "no completion available for expression"
      );
      return;
    }

    if (body.indexedVariables !== undefined) {
      this.sendErrorResponse(
        response,
        2032,
        "no completion available for arrays"
      );
      return;
    }

    const variableArgs: DebugProtocol.VariablesArguments = {
      variablesReference: body.variablesReference,
    };
    response.command = "variables";
    body = await this.sendThreadRequest(thread, response, variableArgs);

    response.command = "completions";
    response.body = {
      targets: body.map((property) => ({
        label: property.name,
        type: "field",
      })),
    };

    this.sendResponse(response);
  }

  // protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
  // 	this.log(`Loading source: ${args.source!.path}`);
  // 	response.body = {
  // 		content: ('This is the source for ' + args.source!.path + '\n').repeat(2000),
  // 		mimeType: 'text/plain'
  // 	};

  // 	this.sendResponse(response);
  // }
}
