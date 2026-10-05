// BlockNexus 桌面外壳（WinForms + WebView2，系统自带 csc 编译）
//
// 双击 BlockNexus.exe：
//   1) 立刻弹出**自己的桌面主窗口**（WebView2 先显示启动页），同一后台线程拉起
//      面板/本地 Agent（node panel/server.js，经 scripts/blocknexus-launcher.js --panel-only），
//      面板就绪后主窗口自动载入前端页面。
//   2) 不再使用 msedge --app 开窗 —— 那条链路在普通权限下会被用户日常浏览器实例
//      接管（面板被开成普通标签页 / 窗口丢失），只有管理员权限才稳定，故废弃。
//   3) 系统托盘常驻 BlockNexus 图标，菜单两项：
//        打开主页    显示/聚焦主窗口
//        完全退出    停面板 + 停本地 Agent + 关窗口 + 收托盘
//   4) 主窗口点 X：只藏窗口，后台继续；再点托盘/再双击即恢复。
//   5) 第二次双击 exe：单实例互斥量 + 命名事件，通知已有实例把主窗口带到前台。
//
// 命令行用法（供脚本/其他进程复用）：
//   BlockNexus.exe --exit-tray      请已在运行的托盘优雅退出
//   BlockNexus.exe --stop           完全退出（停面板/Agent + 收托盘）
//   BlockNexus.exe --close-window   只藏主窗口（后台继续运行）
//
// 环境变量 BLOCKNEXUS_ROOT：指定项目根目录（默认从 exe 所在目录向上找 panel/server.js）

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace BlockNexus
{
    internal static class TrayApp
    {
        private const string MutexName = @"Local\BlockNexusTrayMutex";
        private const string ExitEventName = @"Local\BlockNexusExitTrayEvent";
        private const string ShowEventName = @"Local\BlockNexusShowWindowEvent";
        private const string HideEventName = @"Local\BlockNexusHideWindowEvent";

        private static EventWaitHandle _exitEvent;
        private static EventWaitHandle _showEvent;
        private static EventWaitHandle _hideEvent;

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct NOTIFYICONDATA
        {
            public uint cbSize;
            public IntPtr hWnd;
            public uint uID;
            public uint uFlags;
            public uint uCallbackMessage;
            public IntPtr hIcon;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string szTip;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern bool Shell_NotifyIcon(uint dwMessage, ref NOTIFYICONDATA lpData);

        private static Mutex _mutex;
        private static NotifyIcon _tray;
        private static ToolStripMenuItem _itemOpen;
        private static ToolStripMenuItem _itemExit;
        private static string _root;
        private static string _node;
        private static volatile bool _busy;

        // ---------- 主窗口 ----------
        private static MainForm _form;
        private static volatile bool _exitRequested;   // 「完全退出」时点 X 视为真退出
        private static string _panelUrl = "http://127.0.0.1:3080/";

        [STAThread]
        private static int Main(string[] args)
        {
            AppDomain.CurrentDomain.UnhandledException += (s, e) => LogCrash("fatal: " + e.ExceptionObject);
            Application.ThreadException += (s, e) => LogCrash("thread: " + e.Exception);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            LogStep("Main entered, args=" + string.Join(" ", args));
            EnsureDataDir();

            _root = ResolveRoot();
            LogStep("root=" + _root);
            _node = FindNode();
            LogStep("node=" + (_node ?? "(null)"));

            if (_node == null)
            {
                MessageBox.Show(
                    "未找到 Node.js（需要 18 或更高版本）。\n请先安装：https://nodejs.org",
                    "BlockNexus", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            // 项目根校验：外壳只是桌面窗口，后端面板要靠项目文件拉起。
            // 缺失时明确告知怎么部署，而不是打开一个必然“拒绝连接”的空白页。
            if (!File.Exists(Path.Combine(_root, "panel", "server.js")) ||
                !File.Exists(Path.Combine(_root, "scripts", "blocknexus-launcher.js")))
            {
                MessageBox.Show(
                    "BlockNexus 外壳没有找到项目文件（panel/server.js）。\n\n" +
                    "外壳只是桌面窗口，后端面板需要项目文件才能启动：\n" +
                    "· 使用 BlockNexus-portable 整合包：整体解压到任意目录后直接运行（推荐）；\n" +
                    "· 或把外壳解压到项目根目录（含 panel/、scripts/、web/dist 的目录）；\n" +
                    "· 或在本目录放 root.txt（内容为项目根路径），或设置环境变量 BLOCKNEXUS_ROOT。",
                    "BlockNexus", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 1;
            }

            EnsureDataDir();
            _panelUrl = ReadPanelUrl();

            // 单实例：已有实例在跑时，第二份只负责把主窗口带到前台 / 转发命令
            bool createdNew = true;
            try { _mutex = new Mutex(true, MutexName, out createdNew); }
            catch { createdNew = true; }
            LogStep("mutex createdNew=" + createdNew);

            if (!createdNew)
            {
                if (args.Length > 0 && args[0] == "--exit-tray")
                {
                    // 只收界面外壳与托盘图标；面板/Agent 继续后台运行（npm run exit-tray 语义）
                    SetNamedEvent(ExitEventName, "exit(shell-only)");
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--stop")
                {
                    // 完全退出：先停面板/Agent（本进程直接执行），再请外壳退出
                    RunLauncher("--stop", true);
                    SetNamedEvent(ExitEventName, "exit(stop)");
                    return 0;
                }
                if (args.Length > 0 && args[0] == "--close-window")
                {
                    LogStep("second instance: request hide");
                    SetNamedEvent(HideEventName, "hide");
                    return 0;
                }
                // 第二次双击：通知已有实例显示主窗口
                LogStep("second instance: request show");
                SetNamedEvent(ShowEventName, "show");
                return 0;
            }

            // ---- 首实例：唯一常驻进程 ----

            if (args.Length > 0 && (args[0] == "--exit-tray" || args[0] == "--stop" || args[0] == "--close-window"))
            {
                // 没有已运行实例：完全退出无事可做；--close-window 顺手把后台拉起（与旧语义一致）
                if (args[0] == "--close-window") RunLauncher("--panel-only", false);
                LogStep("no running instance, command no-op: " + args[0]);
                return 0;
            }

            // 命名事件：退出 / 显示主窗 / 藏主窗
            try { _exitEvent = new EventWaitHandle(false, EventResetMode.ManualReset, ExitEventName); }
            catch { }
            try { _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName); }
            catch { }
            try { _hideEvent = new EventWaitHandle(false, EventResetMode.AutoReset, HideEventName); }
            catch { }

            if (_exitEvent != null)
            {
                new Thread(() =>
                {
                    try { _exitEvent.WaitOne(); _exitRequested = true; Application.Exit(); }
                    catch { }
                }) { IsBackground = true }.Start();
            }
            if (_showEvent != null)
            {
                new Thread(() =>
                {
                    try { while (_showEvent.WaitOne()) ShowMainWindowSafe(); }
                    catch { }
                }) { IsBackground = true }.Start();
            }
            if (_hideEvent != null)
            {
                new Thread(() =>
                {
                    try
                    {
                        while (_hideEvent.WaitOne())
                        {
                            var f = _form;
                            if (f != null && f.IsHandleCreated && f.InvokeRequired)
                                f.BeginInvoke((Action)HideMainWindow);
                            else HideMainWindow();
                        }
                    }
                    catch { }
                }) { IsBackground = true }.Start();
            }

            BuildTray();
            LogStep("BuildTray done, tray visible");
            PromoteTrayIcon();

            // 桌面程序主体：主窗口在 UI 线程创建（不显示），WebView2 异步初始化
            _form = new MainForm();
            var forceHandle = _form.Handle;   // 强制在 UI 线程创建句柄，供 BeginInvoke 使用
            GC.KeepAlive(forceHandle);
            SafeText("BlockNexus · 正在启动…");
            InitWebAsync();

            // 后台：拉起面板/Agent；就绪后主窗口载入真实页面并显示
            new Thread(StartupFlow) { IsBackground = true }.Start();

            Application.Run();
            LogStep("Application.Run returned (exiting)");

            try { if (_form != null) _form.Dispose(); } catch { }
            if (_tray != null)
            {
                try { _tray.Visible = false; _tray.Dispose(); } catch { }
            }
            try { _mutex.ReleaseMutex(); } catch { }
            LogStep("process exit");
            return 0;
        }

        private static void StartupFlow()
        {
            try
            {
                RunLauncher("--panel-only", true);   // 拉起面板 + 本地 Agent（等待就绪，不开浏览器）
                var f = _form;
                if (f != null && !f.IsDisposed)
                {
                    f.BeginInvoke((Action)(() => f.NavigatePanel(_panelUrl)));
                }
            }
            catch (Exception e) { LogStep("startup flow exception: " + e.Message); }
            ShowMainWindowSafe();
        }

        // ---------- 主窗口 ----------

        private sealed class MainForm : Form
        {
            public readonly WebView2 Web = new WebView2();
            public string PendingUrl;    // WebView2 未就绪时先挂起，初始化完成后补航
            private volatile bool _webReady;

            public MainForm()
            {
                Text = "BlockNexus · MC 服务器管理面板";
                Icon = LoadAppIcon();
                StartPosition = FormStartPosition.CenterScreen;
                // 进程已是 PerMonitorV2（见 app.manifest）：坐标即物理像素。
                // 窗口尺寸按当前屏幕 DPI 手动缩放（150% 屏 → 1950x1320 物理像素），
                // WebView2 内容随后按原生分辨率渲染，不再被系统位图拉伸发虚。
                float s = DeviceDpi / 96f;
                Size = new Size((int)(1300 * s), (int)(880 * s));
                MinimumSize = new Size((int)(960 * s), (int)(640 * s));
                AutoScaleMode = AutoScaleMode.None;   // 尺寸已手动按 DPI 缩放，避免二次缩放
                Controls.Add(Web);
                Web.Dock = DockStyle.Fill;
                FormClosing += OnFormClosing;
                Web.CoreWebView2InitializationCompleted += OnWebInitCompleted;
            }

            /** 统一导航入口：不经过 Source setter（避免隐式二次 EnsureCoreWebView2 竞争） */
            public void NavigatePanel(string url)
            {
                if (_webReady)
                {
                    try { Web.CoreWebView2.Navigate(url); LogStep("navigate: " + url); }
                    catch (Exception e) { LogStep("navigate failed: " + e.Message); }
                }
                else
                {
                    PendingUrl = url;
                    LogStep("navigate deferred until webview ready: " + url);
                }
            }

            private void OnFormClosing(object sender, FormClosingEventArgs e)
            {
                if (_exitRequested) return;   // 完全退出：放行
                // 点 X = 只藏窗口，后台继续
                e.Cancel = true;
                Hide();
                LogStep("main form hidden (X clicked)");
            }

            private void OnWebInitCompleted(object sender, CoreWebView2InitializationCompletedEventArgs e)
            {
                if (!e.IsSuccess)
                {
                    LogStep("WebView2 init FAILED: " +
                        (e.InitializationException == null ? "?" : e.InitializationException.Message));
                    return;
                }
                _webReady = true;
                try
                {
                    Web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    Web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                    // 面板里不允许出现外部网页：跨站导航一律取消并交系统默认浏览器；
                    // 同面板主机的目标（页面自身跳转）留在壳内
                    Web.CoreWebView2.NavigationStarting += (s3, e3) =>
                    {
                        Uri panel, target;
                        if (Uri.TryCreate(_panelUrl, UriKind.Absolute, out panel)
                            && Uri.TryCreate(e3.Uri, UriKind.Absolute, out target)
                            && (target.Scheme == "http" || target.Scheme == "https")
                            && !string.Equals(panel.Host, target.Host, StringComparison.OrdinalIgnoreCase))
                        {
                            e3.Cancel = true;
                            LogStep("external nav blocked -> shell: " + e3.Uri);
                            try
                            {
                                Process.Start(new ProcessStartInfo(e3.Uri) { UseShellExecute = true });
                            }
                            catch { }
                        }
                    };
                    // 新开窗口（target=_blank）同样分流：壳内主机留在壳内，其余交默认浏览器
                    Web.CoreWebView2.NewWindowRequested += (s2, e2) =>
                    {
                        e2.Handled = true;
                        Uri panel, target;
                        bool same = Uri.TryCreate(_panelUrl, UriKind.Absolute, out panel)
                            && Uri.TryCreate(e2.Uri, UriKind.Absolute, out target)
                            && string.Equals(panel.Host, target.Host, StringComparison.OrdinalIgnoreCase);
                        if (same)
                        {
                            try { Web.CoreWebView2.Navigate(e2.Uri); } catch { }
                        }
                        else
                        {
                            try
                            {
                                Process.Start(new ProcessStartInfo(e2.Uri) { UseShellExecute = true });
                            }
                            catch { }
                        }
                    };
                }
                catch { }
                try { Web.NavigateToString(PlaceholderHtml()); }
                catch { }
                if (!string.IsNullOrEmpty(PendingUrl))
                {
                    var url = PendingUrl; PendingUrl = null;
                    try { Web.CoreWebView2.Navigate(url); LogStep("deferred navigate: " + url); }
                    catch (Exception ex) { LogStep("deferred navigate failed: " + ex.Message); }
                }
            }
        }

        private static string PlaceholderHtml()
        {
            return "<!doctype html><html><head><meta charset='utf-8'><title>BlockNexus</title></head>" +
                "<body style=\"margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
                "background:#0b0f19;color:#94a3b8;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif;\">" +
                "<div style=\"text-align:center\">" +
                "<div style=\"font-size:34px;color:#e2e8f0;font-weight:600;margin-bottom:10px\">BlockNexus</div>" +
                "<div style=\"font-size:15px\">正在启动面板，请稍候…</div></div></body></html>";
        }

        private static async System.Threading.Tasks.Task InitWebAsync()
        {
            var f = _form;
            if (f == null) return;
            try
            {
                // user-data-folder 放项目 data 下。不用 %LOCALAPPDATA%\BlockNexus\webview2-profile：
                // 该路径曾被异常退出留下孤儿锁 → WebView2 报 0x800700AA（资源正在使用）。
                var userData = Path.Combine(_root, "data", "webview2-profile");
                var env = await CoreWebView2Environment.CreateAsync(null, userData);
                await f.Web.EnsureCoreWebView2Async(env);
                LogStep("WebView2 ready");
            }
            catch (Exception e)
            {
                LogStep("InitWebAsync failed: " + e.Message);
                try
                {
                    f.BeginInvoke((Action)(() =>
                    {
                        try
                        {
                            f.Web.NavigateToString(
                                "<!doctype html><meta charset='utf-8'><body style=\"background:#0b0f19;color:#f87171;" +
                                "font-family:'Microsoft YaHei UI';display:flex;align-items:center;justify-content:center;" +
                                "height:100vh;margin:0\"><div style='text-align:center'>WebView2 初始化失败：<br>" +
                                HttpE(e.Message) + "<br><br>请安装 WebView2 运行时后重试。</div></body>");
                        }
                        catch { }
                    }));
                }
                catch { }
            }
        }
        private static string HttpE(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
        }

        private static void HideMainWindow()
        {
            try
            {
                var f = _form;
                if (f != null && !f.IsDisposed) f.Hide();
                LogStep("main form hidden (event)");
            }
            catch { }
        }

        /** 显示主窗口（必须已在 UI 线程上执行，或经 BeginInvoke 调度） */
        private static void ShowMainWindow()
        {
            try
            {
                var f = _form;
                if (f == null || f.IsDisposed) return;
                f.Show();
                if (f.WindowState == FormWindowState.Minimized) f.WindowState = FormWindowState.Normal;
                f.Activate();
                SetForegroundWindow(f.Handle);
                SafeText("BlockNexus");
            }
            catch (Exception e) { LogStep("ShowMainWindow failed: " + e.Message); }
        }

        /** 任意线程调用：把「显示主窗」调度到 UI 线程 */
        private static void ShowMainWindowSafe()
        {
            try
            {
                var f = _form;
                if (f != null && f.IsHandleCreated && f.InvokeRequired)
                {
                    f.BeginInvoke((Action)ShowMainWindow);
                    return;
                }
                ShowMainWindow();
            }
            catch (Exception e)
            {
                LogStep("ShowMainWindowSafe failed: " + e.Message);
            }
        }

        // ---------- 托盘 ----------

        private static void BuildTray()
        {
            var menu = new ContextMenuStrip();
            menu.Font = new Font("Microsoft YaHei UI", 9.5f);
            menu.ShowImageMargin = false;

            _itemOpen = new ToolStripMenuItem("打开主页");
            _itemOpen.Click += (s, e) => ShowMainWindowSafe();

            _itemExit = new ToolStripMenuItem("完全退出");
            _itemExit.ForeColor = Color.FromArgb(185, 28, 28);
            _itemExit.Click += (s, e) => ExitApp();

            menu.Items.Add(_itemOpen);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(_itemExit);

            _tray = new NotifyIcon();
            var icon = LoadIcon();
            LogStep("tray icon loaded=" + (icon != null));
            // 兜底：资源/文件都加载失败时用系统图标，绝不让 NotifyIcon 在 Icon=null 时静默不显示
            _tray.Icon = icon ?? SystemIcons.Application;
            _tray.Text = "BlockNexus";
            _tray.ContextMenuStrip = menu;
            _tray.Visible = true;

            // 诊断：用自有窗口直接向 Shell 注册探针图标，验证本进程此刻 Shell_NotifyIcon 是否可用。
            // NotifyIcon 的 NIM_ADD 失败时不抛错（图标静默消失），探针能把「Shell 拒绝」和「NotifyIcon 内部问题」区分开。
            bool shellAcceptsIcons = false;
            try
            {
                var probeWnd = new NativeWindow();
                probeWnd.CreateHandle(new CreateParams());
                var nid = new NOTIFYICONDATA
                {
                    cbSize = (uint)Marshal.SizeOf(typeof(NOTIFYICONDATA)),
                    hWnd = probeWnd.Handle,
                    uID = 0x5A5A,
                    uFlags = 0x1 | 0x2 | 0x4, // NIF_MESSAGE | NIF_ICON | NIF_TIP
                    uCallbackMessage = 0x500 + 0x5A5A,
                    hIcon = _tray.Icon.Handle,
                    szTip = "bn-probe",
                };
                shellAcceptsIcons = Shell_NotifyIcon(0x0 /* NIM_ADD */, ref nid);
                LogStep("probe NIM_ADD=" + shellAcceptsIcons);
                if (shellAcceptsIcons) Shell_NotifyIcon(0x2 /* NIM_DELETE */, ref nid);
                probeWnd.DestroyHandle();
            }
            catch (Exception ex) { LogStep("probe fail: " + ex.Message); }

            // 探针失败（shell 拒绝注册）时延迟重试几次 NIM_ADD；探针成功则说明图标已注册，不再折腾
            if (!shellAcceptsIcons)
            {
                var readdTimer = new System.Windows.Forms.Timer { Interval = 5000 };
                int readds = 0;
                readdTimer.Tick += (s, e) =>
                {
                    readds++;
                    try
                    {
                        _tray.Visible = false;
                        _tray.Visible = true;
                        LogStep("tray icon re-added (pass " + readds + ")");
                    }
                    catch (Exception ex) { LogStep("tray re-add fail: " + ex.Message); }
                    if (readds >= 2) readdTimer.Stop();
                };
                readdTimer.Start();
            }

            // 左键直接打开主页
            _tray.MouseUp += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) ShowMainWindowSafe();
            };
        }

        /// <summary>
        /// 首次运行时把托盘图标从「隐藏图标溢出区」提升到任务栏可见区。
        /// Windows 对新出现的 NotifyIcon 默认不予提升（IsPromoted 缺失），图标会被收进
        /// 通知区域的 ^ 面板里，用户会以为"托盘没出来"。每次启动幂等置一次 IsPromoted=1。
        /// </summary>
        private static void PromoteTrayIcon()
        {
            // Explorer 为新托盘图标建 NotifyIconSettings 注册项有延迟（首次运行可能要几秒），
            // 建好之前这里的匹配什么也找不到 → 图标被收进溢出区，用户以为托盘没出来。
            // 后台轮询直到注册项出现；只在「从未配置」时置 IsPromoted=1（用户显式关闭过的不覆盖）。
            var t = new Thread(() =>
            {
                for (int i = 0; i < 30; i++)
                {
                    if (PromoteTrayIconOnce()) return;
                    Thread.Sleep(1000);
                }
                LogStep("promote: NotifyIconSettings key never appeared");
            }) { IsBackground = true };
            t.Start();
        }

        /** 返回 true = 找到了本 exe 的注册项（无论是否需要置位） */
        private static bool PromoteTrayIconOnce()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings", true))
                {
                    if (key == null) return false;
                    string exe = null;
                    try { exe = Application.ExecutablePath; } catch { }
                    if (string.IsNullOrEmpty(exe)) return true;
                    foreach (var sub in key.GetSubKeyNames())
                    {
                        using (var k = key.OpenSubKey(sub))
                        {
                            if (k == null) continue;
                            var p = k.GetValue("ExecutablePath") as string;
                            if (string.IsNullOrEmpty(p)) continue;
                            if (!string.Equals(p, exe, StringComparison.OrdinalIgnoreCase)) continue;
                            using (var w = key.OpenSubKey(sub, true))
                            {
                                if (w != null && w.GetValue("IsPromoted") == null)
                                {
                                    w.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                                    LogStep("promote: IsPromoted=1 set");
                                }
                            }
                            return true;
                        }
                    }
                }
            }
            catch { }
            return false;
        }

        private static Icon LoadIcon()
        {
            try
            {
                var asm = Assembly.GetExecutingAssembly();
                using (var stream = asm.GetManifestResourceStream("BlockNexus.AppIcon"))
                {
                    if (stream != null)
                    {
                        var icon = new Icon(stream);
                        var h = icon.Handle;   // 强制物化 Win32 句柄：若失败要在日志里看到，而不是托盘静默消失
                        LogStep("tray icon from resource, handle=" + h);
                        return icon;
                    }
                }
            }
            catch (Exception e) { LogStep("tray icon resource fail: " + e.Message); }
            try
            {
                var file = Path.Combine(_root, "images", "blocknexus.ico");
                if (File.Exists(file))
                {
                    var icon = new Icon(file);
                    var h = icon.Handle;
                    LogStep("tray icon from file, handle=" + h);
                    return icon;
                }
                LogStep("tray icon file missing: " + file);
            }
            catch (Exception e) { LogStep("tray icon file fail: " + e.Message); }
            return null;
        }

        private static Icon LoadAppIcon()
        {
            var icon = LoadIcon();
            if (icon != null) return icon;
            try { return SystemIcons.Application; } catch { return null; }
        }

        private static void SetBusy(bool busy)
        {
            _busy = busy;
            try
            {
                if (_itemOpen != null) _itemOpen.Enabled = !busy;
                if (_itemExit != null) _itemExit.Enabled = !busy;
            }
            catch { }
        }

        private static void SafeText(string text)
        {
            try
            {
                // 托盘提示文本上限 63 字符，超了会抛异常
                if (_tray != null) _tray.Text = text.Length > 63 ? text.Substring(0, 63) : text;
            }
            catch { }
        }

        /** 完全退出：停面板 + 停本地 Agent + 关窗口 + 收托盘 */
        private static void ExitApp()
        {
            if (_busy) return;
            SetBusy(true);
            SafeText("BlockNexus · 正在退出…");
            new Thread(() =>
            {
                try { RunLauncher("--stop", true); } catch { }
                try
                {
                    _tray.ShowBalloonTip(1500, "BlockNexus", "已完全退出（窗口、面板与本地 Agent 已停止）。", ToolTipIcon.Info);
                }
                catch { }
                Thread.Sleep(500);
                _exitRequested = true;
                try
                {
                    var f = _form;
                    if (f != null && f.IsHandleCreated) f.BeginInvoke((Action)(() => { try { f.Close(); } catch { } }));
                }
                catch { }
                Application.Exit();
            }) { IsBackground = true }.Start();
        }

        // ---------- 调用 Node 启动器 ----------

        private static void RunLauncher(string extraArg, bool wait)
        {
            var script = Path.Combine(_root, "scripts", "blocknexus-launcher.js");
            LogStep("RunLauncher arg=" + (extraArg ?? "(null)") + " wait=" + wait + " script=" + script);
            if (!File.Exists(script))
            {
                LogStep("RunLauncher: script NOT FOUND");
                return;
            }

            var psi = new ProcessStartInfo();
            psi.WorkingDirectory = _root;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            var quoted = "\"" + script + "\"";
            if (string.Equals(Path.GetExtension(_node), ".cmd", StringComparison.OrdinalIgnoreCase))
            {
                // node.cmd（少数安装方式）：交给 cmd 执行
                psi.FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe");
                psi.Arguments = "/c \"" + _node + "\" " + quoted +
                    (string.IsNullOrEmpty(extraArg) ? "" : " " + extraArg);
            }
            else
            {
                psi.FileName = _node;
                psi.Arguments = quoted + (string.IsNullOrEmpty(extraArg) ? "" : " " + extraArg);
            }

            try
            {
                Process p;
                try { p = Process.Start(psi); }
                catch (Exception ex)
                {
                    LogStep("RunLauncher: Start threw " + ex.GetType().Name + ": " + ex.Message);
                    return;
                }
                if (p == null)
                {
                    LogStep("RunLauncher: Start returned null");
                    return;
                }
                using (p)
                {
                    LogStep("RunLauncher: child pid=" + p.Id);
                    p.OutputDataReceived += (s, e) => { };
                    p.ErrorDataReceived += (s, e) => { };
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    if (wait && !p.WaitForExit(90000))
                    {
                        LogStep("RunLauncher: timeout, killing child pid=" + p.Id);
                        try { p.Kill(); } catch { }
                    }
                    else if (wait)
                    {
                        LogStep("RunLauncher: child exited code=" + p.ExitCode);
                    }
                }
            }
            catch (Exception ex)
            {
                LogStep("RunLauncher outer " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        // ---------- 路径解析 ----------

        private static string EnsureDataDir()
        {
            try
            {
                var d = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data");
                if (!Directory.Exists(d)) Directory.CreateDirectory(d);
                return d;
            }
            catch { return AppDomain.CurrentDomain.BaseDirectory; }
        }

        /** 打开已存在的命名事件并置位（跨进程通知；需要 Modify 权限） */
        private static void SetNamedEvent(string name, string tag)
        {
            try
            {
                using (var ev = EventWaitHandle.OpenExisting(
                    name, System.Security.AccessControl.EventWaitHandleRights.Modify))
                {
                    ev.Set();
                    LogStep("named event set: " + tag);
                }
            }
            catch (Exception e) { LogStep("named event " + tag + " failed: " + e.Message); }
        }

        private static void LogCrash(string what)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(EnsureDataDir(), "tray-crash.log"),
                    "[" + DateTime.Now.ToString("s") + "] " + what + Environment.NewLine);
            }
            catch { }
        }

        private static void LogStep(string what)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(EnsureDataDir(), "tray-trace.log"),
                    "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] pid=" +
                    Process.GetCurrentProcess().Id + " " + what + Environment.NewLine);
            }
            catch { }
        }

        private static string ReadPanelUrl()
        {
            try
            {
                var f = Path.Combine(_root, "data", "config.json");
                if (!File.Exists(f)) return "http://127.0.0.1:3080/";
                var json = File.ReadAllText(f);
                var m = Regex.Match(json, @"""port""\s*:\s*(\d+)");
                var port = m.Success ? m.Groups[1].Value : "3080";
                return "http://127.0.0.1:" + port + "/";
            }
            catch { return "http://127.0.0.1:3080/"; }
        }

        private static string ResolveRoot()
        {
            var env = Environment.GetEnvironmentVariable("BLOCKNEXUS_ROOT");
            if (!string.IsNullOrEmpty(env) && Directory.Exists(env)) return env;

            var start = AppDomain.CurrentDomain.BaseDirectory;
            // 外壳可与项目分离部署：exe 同目录的 root.txt 指向项目根（shell 目录方案）
            try
            {
                var marker = Path.Combine(start, "root.txt");
                if (File.Exists(marker))
                {
                    foreach (var l in File.ReadAllLines(marker))
                    {
                        if (string.IsNullOrWhiteSpace(l)) continue;
                        var line = l.Trim();
                        if (!string.IsNullOrEmpty(line) &&
                            File.Exists(Path.Combine(line, "panel", "server.js"))) return line;
                        break;
                    }
                }
            }
            catch { }
            var dir = start;
            for (int i = 0; i < 4; i++)
            {
                if (File.Exists(Path.Combine(dir, "panel", "server.js"))) return dir;
                var up = Path.GetDirectoryName(
                    dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                if (string.IsNullOrEmpty(up)) break;
                dir = up;
            }
            return start;
        }

        private static string FindNode()
        {
            var names = new[] { "node.exe", "node.cmd" };
            var dirs = new List<string>();

            dirs.Add(Path.Combine(_root, "runtime"));
            dirs.Add(_root);

            var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var d in pathEnv.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(d)) continue;
                dirs.Add(d.Trim().Trim('"'));
            }

            foreach (var key in new[] { "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA" })
            {
                var baseDir = Environment.GetEnvironmentVariable(key);
                if (string.IsNullOrEmpty(baseDir)) continue;
                dirs.Add(Path.Combine(baseDir, "nodejs"));
                dirs.Add(Path.Combine(baseDir, "Programs", "nodejs"));
                var nvm = Path.Combine(baseDir, "nvm");
                dirs.Add(nvm);
                try
                {
                    if (Directory.Exists(nvm))
                        foreach (var sub in Directory.GetDirectories(nvm)) dirs.Add(sub);
                }
                catch { }
            }

            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var d in dirs)
            {
                if (string.IsNullOrEmpty(d) || !seen.Add(d)) continue;
                foreach (var n in names)
                {
                    try
                    {
                        var p = Path.Combine(d, n);
                        if (File.Exists(p)) return p;
                    }
                    catch { }
                }
            }
            return null;
        }
    }
}
