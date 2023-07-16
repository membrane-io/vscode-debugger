# Membrane Debugger for VSCode


## Usage

Once this extension is installed, add this to `membrane.code-workspace`:

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

