' BlockNexus one-click launcher (hidden window) - target of the desktop shortcut.
' Double click: starts panel + local agents, then opens the app window.
On Error Resume Next

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' project root = parent of the scripts folder (keeps working if the folder moves)
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

' route through cmd: bare "node ..." does not fire reliably from WScript.Shell.Run
sh.Run "cmd /c node scripts\blocknexus-launcher.js", 0, True

If Err.Number <> 0 Then
  Err.Clear
  MsgBox "Failed to start BlockNexus: Node.js was not found." & vbCrLf & "Please install Node.js 18+ (https://nodejs.org) and try again.", 16, "BlockNexus"
End If
