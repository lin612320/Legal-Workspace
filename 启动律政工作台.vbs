Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "E:\DEMO"
' 后台静默启动 Vite 开发服务器（不显示终端窗口）
WshShell.Run "cmd /c set PATH=E:\node-v24.19.0-win-x64\node-v24.19.0-win-x64;%PATH% && npm run dev", 0, False
' 等待服务器就绪后打开浏览器
WScript.Sleep 3000
WshShell.Run "http://localhost:1420"
