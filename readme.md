# QuickJS Debug for VS Code

This is a VS Code debug adapter for [QuickJS](https://bellard.org/quickjs/).

QuickJS Debug supports *stepping*, *continue*, *breakpoints*, *evaluation*, and
*variable access* but it is not connected to any real debugger.

## Using QuickJS Debug

* Install the **QuickJS Debug** extension in VS Code.
* Build the [QuickJS fork](https://github.com/koush/quickjs) from koush.
* Specify the qjs runtime path.
* Switch to the debug viewlet and press the gear dropdown.
* Select the debug environment "QuickJS Debug".
* Press the green 'play' button to start debugging.

You can now 'step through' the `test.js` file, set and hit breakpoints, and run into exceptions (if the word exception appears in a line).

![QuickJS Debug](images/quickjs-debug-demo.png)

## Build and Run


* Clone the project
* Open the project folder in VS Code.
* Press `F5` to build and launch QuickJS Debug in another VS Code window. In that window:
  * Open a new workspace, create a new 'program' file `readme.md` and enter several lines of arbitrary text.
  * Switch to the debug viewlet and press the gear dropdown.
  * Select the debug environment "QuickJS Debug Sample".
  * Press `F5` to start debugging.
