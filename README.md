# Membrane Debugger for VSCode

This is a Visual Studio Code extension that provides debugger support for [membrane.io](https://www.membrane.io) programs.


## Usage

[Install from VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=membrane.membrane-debugger)

Once installed, add this to `membrane.code-workspace`:

```
  "launch": {
    "version": "0.2.0",
    "configurations": [
      {
        "name": "Membrane Debugger",
        "type": "membrane",
        "request": "attach"
      }
    ]
  },
```

## Acknowledgements

This debugger extension is based on the amazing work by @koush:

 - https://github.com/koush/vscode-quickjs-debug
