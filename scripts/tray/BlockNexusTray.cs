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
        // ⚠ 命名内核对象用 Global\：Local\ 在「同用户不同登录会话」与「普通↔提权完整性
        //   级别」之间不可见/不可写，表现为双击提权后事件打不开、旧实例收不到退出/显示
        //   请求 → 提权实例「概率性失效」。Global\ 跨会话跨完整性都可见（同机内核全局）。
        private const string MutexName = @"Global\BlockNexusTrayMutex";
        private const string ExitEventName = @"Global\BlockNexusExitTrayEvent";
        private const string ShowEventName = @"Global\BlockNexusShowWindowEvent";
        private const string HideEventName = @"Global\BlockNexusHideWindowEvent";

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

        // ⚠ 必须带 SetLastError = true：否则调用失败后 Marshal.GetLastWin32Error()
        //   读到的是**上一次无关调用**留下的陈旧错误码，诊断会指向完全错误的方向。
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool Shell_NotifyIcon(uint dwMessage, ref NOTIFYICONDATA lpData);

        /// <summary>查外壳托盘窗口是否存在（诊断用；找不到返回 IntPtr.Zero）</summary>
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        private static Mutex _mutex;
        private static NotifyIcon _tray;
        /// <summary>
        /// 托盘图标是否注册成功。
        /// 失败时必须让主窗口**保持可见**（见 MainForm.OnFormClosing）：否则用户关掉窗口后
        /// 既没有图标可以唤回、也没有窗口，只能去任务管理器结束进程 —— 表现成「程序坏了」。
        /// </summary>
        private static volatile bool _trayOk;
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

            try
            {
                // 命令行（ssh/远程/无交互会话）里双击等价运行时，GDI+ 初始化可能抛
                // 「一般性错误」直接崩掉。吞掉并让 WinForms 用默认主题，保证进程活着。
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
            }
            catch (Exception e) { LogStep("EnableVisualStyles failed (non-interactive session?): " + e.Message); }

            LogStep("Main entered, args=" + string.Join(" ", args));

            _root = ResolveRoot();   // 先解析根，EnsureDataDir 才能把日志写进 <root>/data/logs
            EnsureDataDir();
            MigrateDataLayout();
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
                // 用户明确「以管理员身份运行」时，必须真正切换到提权实例，而不是给
                // 普通旧实例发一个 show 就自己退出。先发退出信号（只退外壳，不动面板），
                // 再等待旧实例释放互斥锁；接管失败要显式提示，绝不静默吞掉。
                if (IsElevated())
                {
                    LogStep("elevated launch: requesting existing shell to hand over");
                    SetNamedEvent(ExitEventName, "exit(elevated handover)");
                    createdNew = WaitForSingleInstanceMutex(15000);
                    if (!createdNew)
                    {
                        MessageBox.Show(
                            "已有 BlockNexus 外壳没有退出，暂时无法切换为管理员实例。\r\n\r\n" +
                            "请先在托盘菜单选择「完全退出」，再右键以管理员身份运行。",
                            "BlockNexus", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return 1;
                    }
                }
                // 互斥量提示「已有实例」但没有活进程时，让位按首实例继续。
                else if (!ExistingProcessAlive())
                {
                    LogStep("mutex held by dead instance, taking over as first instance");
                    try { _mutex.ReleaseMutex(); } catch { }
                    createdNew = true;
                }
                else
                {
                    if (args.Length > 0 && args[0] == "--exit-tray")
                    {
                        // 只收界面外壳与托盘图标；面板/Agent 继续后台运行（npm run exit-tray 语义）
                        if (!SetNamedEvent(ExitEventName, "exit(shell-only)"))
                            ForceKillExisting();   // 事件发不出去（ACL/异常）→ 兜底强杀，不能让「退出」静默失效
                        return 0;
                    }
                    if (args.Length > 0 && args[0] == "--stop")
                    {
                        // 完全退出：先停面板/Agent（本进程直接执行），再请外壳退出
                        RunLauncher("--stop", true);
                        if (!SetNamedEvent(ExitEventName, "exit(stop)"))
                            ForceKillExisting();
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
            // 必须带显式 ACL：默认 DACL 只允许创建者所在完整性与会话访问，普通权限进程
            // 对提权实例创建的事件 OpenExisting(Modify) 会得到 AccessDenied → 双击「完全
            // 退出/显示窗口」概率性被吞。放开 Everyone Modify + 创建者 OwnerWrite。
            _exitEvent = CreateSharedEvent(ExitEventName, EventResetMode.ManualReset);
            _showEvent = CreateSharedEvent(ShowEventName, EventResetMode.AutoReset);
            _hideEvent = CreateSharedEvent(HideEventName, EventResetMode.AutoReset);

            // exit 事件用 ManualReset（信号不会丢）；监听线程在 Application.Run 紧邻启动前
            // 创建，由消息循环正常处理退出。
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

            // ManualReset 事件在监听器建立前置位也不会丢；Application.Exit() 若早于消息
            // 循环，由 Run() 返回后的正常清理收尾，不能在这里漏掉进程退出。
            if (_exitEvent != null)
            {
                new Thread(() =>
                {
                    try { _exitEvent.WaitOne(); _exitRequested = true; Application.Exit(); }
                    catch { }
                }) { IsBackground = true }.Start();
            }

            Application.Run();
            LogStep("Application.Run returned (exiting)");

            try { if (_form != null) _form.Dispose(); } catch { }
            if (_tray != null)
            {
                try { _tray.Visible = false; _tray.Dispose(); } catch { }
            }
            // _mutex 可能已在 RestartElevated 里提前释放并置空（提权重启路径）
            try { if (_mutex != null) _mutex.ReleaseMutex(); } catch { }
            LogStep("process exit");
            return 0;
        }

        private static void StartupFlow()
        {
            // 面板就绪失败时重试一次（覆盖：首次启动 WebView2/Node 较慢、端口短暂被占用
            // 刚释放等瞬态）。两次都失败就在主窗口显示明确错误，而不是停在空白启动页。
            for (int attempt = 1; attempt <= 2; attempt++)
            {
                try
                {
                    SafeText(attempt == 1 ? "BlockNexus · 正在启动…" : "BlockNexus · 正在重试…");
                    LogStep("startup flow attempt " + attempt);
                    RunLauncher("--panel-only", true);   // 拉起面板 + 本地 Agent（等待就绪）
                    if (PanelReachable())
                    {
                        var f = _form;
                        if (f != null && !f.IsDisposed)
                        {
                            f.BeginInvoke((Action)(() => f.NavigatePanel(_panelUrl)));
                        }
                        ShowMainWindowSafe();
                        return;
                    }
                    LogStep("startup attempt " + attempt + ": panel not reachable yet");
                }
                catch (Exception e) { LogStep("startup flow exception (attempt " + attempt + "): " + e.Message); }
            }
            LogStep("panel unreachable after retries, showing error page");
            ShowStartupError();
            ShowMainWindowSafe();
        }

        /** 面板 HTTP 是否可达（就绪探测；超时短，由 RunLauncher 的长等负责主等待） */
        private static bool PanelReachable()
        {
            try
            {
                var url = _panelUrl.TrimEnd('/') + "/api/me";
                var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(url);
                req.Timeout = 2000;
                req.Method = "GET";
                using (var resp = (System.Net.HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode < 500;
                }
            }
            catch { return false; }
        }

        private static void ShowStartupError()
        {
            try
            {
                var f = _form;
                if (f == null || f.IsDisposed) return;
                f.BeginInvoke((Action)(() =>
                {
                    try
                    {
                        f.Web.NavigateToString(
                            "<!doctype html><meta charset='utf-8'><body style=\"background:#0b0f19;color:#f87171;" +
                            "font-family:'Microsoft YaHei UI';display:flex;align-items:center;justify-content:center;" +
                            "height:100vh;margin:0\"><div style='text-align:center;max-width:70%'>" +
                            "<div style='font-size:20px;margin-bottom:12px'>面板启动失败</div>" +
                            "<div style='color:#94a3b8;font-size:13px;line-height:1.7'>" +
                            "后台面板在重试后仍未就绪。<br>请查看日志 data\\logs\\panel.log 与 data\\logs\\launcher.log，" +
                            "或关闭后重新打开 BlockNexus.exe。</div></div></body>");
                    }
                    catch { }
                }));
            }
            catch { }
        }

        // ---------- 主窗口 ----------

        private sealed class MainForm : Form
        {
            public readonly WebView2 Web = new WebView2();
            public string PendingUrl;    // WebView2 未就绪时先挂起，初始化完成后补航
            private volatile bool _webReady;
            /** 托盘不可用时的常驻提示条（null = 未创建） */
            private Panel _notice;

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

                // ⚠ 托盘不可用时**绝不能**藏窗口。
                //   藏了之后既没有托盘图标、也没有窗口 —— 用户只能去任务管理器结束进程，
                //   表现成「程序坏了/被杀软删了」。这是比「看不到图标」严重得多的问题。
                //   改为明确询问，并给出「以管理员重启」这条实测有效的出路。
                if (!_trayOk)
                {
                    e.Cancel = true;
                    string msg =
                        "托盘图标不可用，关闭窗口后将无法再次打开（只能用任务管理器结束进程）。\r\n\r\n" +
                        "是否尝试以管理员身份重启？（实测提权启动可以正常注册托盘图标）";
                    var r = MessageBox.Show(msg, "BlockNexus", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
                    if (r == DialogResult.Yes)
                    {
                        RestartElevated();     // 成功后内部会 Application.Exit()
                    }
                    else if (r == DialogResult.No)
                    {
                        _exitRequested = true; // 用户明确选择退出
                        Close();
                    }
                    return;
                }

                // 正常情况：点 X = 只藏窗口，后台继续
                e.Cancel = true;
                Hide();
                LogStep("main form hidden (X clicked)");
            }

            /// <summary>
            /// 托盘注册彻底失败时，在主窗口顶部显示常驻提示条。
            ///
            /// 刻意**不写失败原因**：根因未查明（已排除受限令牌、.NET 信任级别、AppContainer、
            /// Smart App Control、第三方安全软件、清单、注册表 ACL），凭推测写「因为 XX」只会
            /// 误导用户。这里只陈述现象 + 给出可操作动作。
            /// </summary>
            public void ShowTrayNotice(bool relaunched)
            {
                if (_notice != null) return;   // 幂等：可能被重试逻辑多次触发
                var p = new Panel
                {
                    Dock = DockStyle.Top,
                    Height = 46,
                    BackColor = Color.FromArgb(255, 244, 214),
                    Padding = new Padding(12, 8, 12, 8),
                };
                var lbl = new Label
                {
                    Dock = DockStyle.Fill,
                    AutoSize = false,
                    Text = relaunched
                        ? "无法注册系统托盘图标（已以管理员身份运行过）。关闭窗口后将无法再次打开，请保留窗口或结束时用任务管理器。"
                        : "无法注册系统托盘图标。关闭窗口后将无法再次打开（只能用任务管理器结束进程）。",
                    ForeColor = Color.FromArgb(120, 70, 0),
                };
                var actions = new FlowLayoutPanel
                {
                    Dock = DockStyle.Right,
                    AutoSize = true,
                    FlowDirection = FlowDirection.LeftToRight,
                    WrapContents = false,
                };
                if (!relaunched)
                {
                    var b1 = new Button { Text = "以管理员身份重启", AutoSize = true };
                    b1.Click += (s, e) => RestartElevated();
                    actions.Controls.Add(b1);
                }
                var b2 = new Button { Text = relaunched ? "知道了" : "继续使用", AutoSize = true };
                b2.Click += (s, e) =>
                {
                    // 只收起提示条；关闭行为仍然按 _trayOk 走（不隐藏窗口）
                    try { Controls.Remove(p); p.Dispose(); } catch { }
                    _notice = null;
                };
                actions.Controls.Add(b2);
                p.Controls.Add(lbl);
                p.Controls.Add(actions);
                // 后添加的子控件先占位：先加 lbl(Fill) 再加 actions(Right)，
                // actions 会拿到右侧贴边、lbl 让出那块 —— 与顶层 Dock 的规则一致。
                Controls.Add(p);
                _notice = p;
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
                // user-data-folder 是浏览器可再生缓存，放 data/cache；不放 %LOCALAPPDATA%：
                // 该路径曾被异常退出留下孤儿锁 → WebView2 报 0x800700AA（资源正在使用）。
                var userData = Path.Combine(_root, "data", "cache", "webview2-profile");
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
            int probeErr = 0;
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
                // 失败时保留 win32err：它是唯一能区分原因的信息
                // （5=权限/完整性 1460=外壳未就绪 87=参数被拒 1400=窗口无效）。
                if (!shellAcceptsIcons) probeErr = Marshal.GetLastWin32Error();
                if (shellAcceptsIcons) Shell_NotifyIcon(0x2 /* NIM_DELETE */, ref nid);
                probeWnd.DestroyHandle();
            }
            catch (Exception ex) { LogStep("probe fail: " + ex.GetType().Name + ": " + ex.Message); }
            LogStep("probe NIM_ADD=" + shellAcceptsIcons + " win32err=" + probeErr);

            if (shellAcceptsIcons)
            {
                _trayOk = true;
            }
            else
            {
                // 先假定是**暂时**失败，按 2s 间隔重试真图标，上限 60s。
                //
                // 这条覆盖最真实的常见原因：用户把程序加进启动项 → 开机时 Explorer 的
                // 托盘还没就绪 → NIM_ADD 返回 1460(ERROR_TIMEOUT)。原先只重试 2 次
                // （5s/10s）就放弃，对开机自启场景太短，用户会以为「偶尔没有图标」。
                //
                // 重试的是**真图标**（翻转 _tray.Visible），不是探针：探针只回答
                // 「这一刻行不行」，而这里要解决的是「图标到底挂上没有」。
                var retry = new System.Windows.Forms.Timer { Interval = 2000 };
                int tries = 0;
                var deadline = DateTime.UtcNow.AddSeconds(90);
                retry.Tick += (s, e) =>
                {
                    tries++;
                    try { _tray.Visible = false; _tray.Visible = true; } catch { }
                    int err2 = 0;
                    if (TryProbeTray(out err2))
                    {
                        retry.Stop();
                        _trayOk = true;
                        LogStep("tray icon registered after retry #" + tries);
                        return;
                    }
                    if (DateTime.UtcNow >= deadline)   // 上限 ~90s，覆盖开机自启/外壳慢就绪
                    {
                        retry.Stop();
                        _trayOk = false;
                        LogStep("tray icon registration failed after " + tries + " tries, win32err=" + err2);
                        OnTrayUnavailable();
                    }
                    else
                    {
                        // 轻退避：越到后面间隔越大，减少无效探测
                        retry.Interval = Math.Min(6000, 2000 + tries * 500);
                    }
                };
                retry.Start();
            }

            // 左键直接打开主页
            _tray.MouseUp += (s, e) =>
            {
                if (e.Button == MouseButtons.Left) ShowMainWindowSafe();
            };
        }

        /// <summary>
        /// 探针：用**独立临时窗口 + 独立 uID** 尝试向 Shell 注册一个图标，随后立刻删掉。
        ///
        /// 为什么需要：NotifyIcon 的 NIM_ADD 失败时**不抛异常**（图标静默消失），
        /// 调用方无从得知，而这是唯一能提前发现「本进程用不了托盘」的手段。
        /// 独立窗口保证不污染真图标；失败时给出 Win32 错误码（5=权限/完整性、
        /// 1460=外壳未就绪、87=参数被拒、1400=窗口无效）。
        /// </summary>
        private static bool TryProbeTray(out int err)
        {
            err = 0;
            try
            {
                var w = new NativeWindow();
                w.CreateHandle(new CreateParams());
                var nid = new NOTIFYICONDATA
                {
                    cbSize = (uint)Marshal.SizeOf(typeof(NOTIFYICONDATA)),
                    hWnd = w.Handle,
                    uID = 0x5A5A,
                    uFlags = 0x1 | 0x2 | 0x4, // NIF_MESSAGE | NIF_ICON | NIF_TIP
                    uCallbackMessage = 0x500 + 0x5A5A,
                    hIcon = _tray.Icon.Handle,
                    szTip = "bn-probe",
                };
                bool ok = Shell_NotifyIcon(0x0 /* NIM_ADD */, ref nid);
                if (ok) Shell_NotifyIcon(0x2 /* NIM_DELETE */, ref nid);
                else err = Marshal.GetLastWin32Error();
                w.DestroyHandle();
                return ok;
            }
            catch (Exception ex)
            {
                LogStep("probe exception: " + ex.GetType().Name + ": " + ex.Message);
                return false;
            }
        }

        /// <summary>
        /// 托盘注册彻底失败（重试 60s 后仍不行）时的降级入口。
        /// 做法是「告诉用户 + 让窗口留着」，而不是继续重试或静默接受。
        /// </summary>
        private static void OnTrayUnavailable()
        {
            try
            {
                var f = _form;
                if (f == null || !f.IsHandleCreated) return;
                f.BeginInvoke((Action)(() =>
                {
                    try
                    {
                        f.ShowTrayNotice(HasRelaunchFlag());
                    }
                    catch (Exception ex) { LogStep("ShowTrayNotice fail: " + ex.Message); }
                }));
            }
            catch (Exception ex) { LogStep("OnTrayUnavailable fail: " + ex.Message); }
        }

        /** 本次进程是否由「以管理员身份重启」拉起（防 UAC 循环） */
        private static bool HasRelaunchFlag()
        {
            try
            {
                foreach (var a in Environment.GetCommandLineArgs())
                    if (string.Equals(a, "--relaunched", StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch { }
            return false;
        }

        /// <summary>
        /// 以管理员身份重启自己。
        ///
        /// 只在用户点按钮时触发，**绝不自动提权**：绝大多数用户不需要，而代价是每次启动
        /// 都弹 UAC，且提权后 UIPI 会拦住与普通权限窗口的交互（以后若要加「拖文件到窗口」
        /// 之类会失效）。带 `--relaunched` 传递，保证重启后仍失败时不再引导提权。
        /// </summary>
        private static bool RestartElevated()
        {
            try
            {
                // ⚠ 必须**先释放单实例互斥锁**，再拉起新进程。
                //
                // 否则：新进程可能在我们真正退出之前就抢到锁做检查 → 看到
                // createdNew=False → 误判为「已有实例在运行」→ 只给旧实例发一个
                // 「显示窗口」事件然后自己退出。提权重启就被**静默吞掉**了，
                // 用户看到的是「点了按钮什么都没发生」。
                // （这不是假想：本项目就踩过同一个坑 —— 普通实例占着锁时，
                //   提权启动完全无效，日志里连一条新记录都没有。）
                try { _mutex.ReleaseMutex(); } catch { }
                try { _mutex.Dispose(); } catch { }
                _mutex = null;

                var psi = new ProcessStartInfo
                {
                    FileName = Application.ExecutablePath,
                    Arguments = "--relaunched",
                    UseShellExecute = true,   // runas 动词要求 UseShellExecute=true
                    Verb = "runas",
                };
                Process.Start(psi);
                _exitRequested = true;        // 放行 FormClosing，真正退出
                Application.Exit();
                return true;
            }
            catch (Exception ex)
            {
                // 最常见的是用户在 UAC 弹窗上点了「否」（抛 Win32Exception 1223）
                LogStep("RestartElevated fail: " + ex.GetType().Name + ": " + ex.Message);
                MessageBox.Show(
                    "无法以管理员身份重启（可能你在 UAC 提示上点了“否”）。\r\n\r\n" +
                    "可以手动右键 BlockNexus.exe 选择“以管理员身份运行”。",
                    "BlockNexus",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return false;
            }
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
                    // ⚠ 必须遍历**全部**匹配项，不能命中第一条就 return：
                    //   Windows 会为同一个 exe 累积多条 NotifyIconSettings 记录
                    //   （每次以不同方式注册/不同 hWnd+uID 都可能新增一条），
                    //   而**只有当前实例真正用的那条**被提升才有意义。
                    //   原先「处理第一条就返回」在有重复条目时会稳定地提升错的那条 →
                    //   用户开了「其他系统托盘图标」开关也依然看不到图标。
                    bool found = false;
                    foreach (var sub in key.GetSubKeyNames())
                    {
                        using (var k = key.OpenSubKey(sub))
                        {
                            if (k == null) continue;
                            var p = k.GetValue("ExecutablePath") as string;
                            if (string.IsNullOrEmpty(p)) continue;
                            if (!string.Equals(p, exe, StringComparison.OrdinalIgnoreCase)) continue;
                            found = true;
                            using (var w = key.OpenSubKey(sub, true))
                            {
                                if (w != null && w.GetValue("IsPromoted") == null)
                                {
                                    w.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                                    LogStep("promote: IsPromoted=1 set on " + sub);
                                }
                            }
                        }
                    }
                    if (found) return true;
                }
            }
            catch (Exception ex)
            {
                // ⚠ 绝不能静默吞掉：catch {} 会让上层把「权限不足/异常」误报成
                //   「注册项从未出现」，把排查引向完全错误的方向（我就被它误导过）。
                LogStep("promote: exception: " + ex.GetType().Name + ": " + ex.Message);
            }
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
            // launcher 的退出兜底只认当前外壳 PID，不用 taskkill /IM 误杀其他安装目录。
            psi.EnvironmentVariables["BLOCKNEXUS_TRAY_PID"] = Process.GetCurrentProcess().Id.ToString();

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

        /// <summary>
        /// 日志目录：统一收敛到 <项目根>/data/logs/。
        /// 历史上 tray 日志写在「exe 同目录/data」（外壳分离部署时与项目 data/ 分离），
        /// 诊断要翻两个地方。现在以解析出的项目根为准（_root 在 Main 早期就已就绪，
        /// 晚于 EnsureDataDir 首次调用时回退到 base/data 仍可用）。
        /// </summary>
        private static string EnsureDataDir()
        {
            try
            {
                var root = _root ?? AppDomain.CurrentDomain.BaseDirectory;
                var d = Path.Combine(root, "data", "logs");
                if (!Directory.Exists(d)) Directory.CreateDirectory(d);
                return d;
            }
            catch
            {
                try
                {
                    var d = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "data", "logs");
                    if (!Directory.Exists(d)) Directory.CreateDirectory(d);
                    return d;
                }
                catch { return AppDomain.CurrentDomain.BaseDirectory; }
            }
        }

        private static bool IsElevated()
        {
            try
            {
                using (var id = System.Security.Principal.WindowsIdentity.GetCurrent())
                    return new System.Security.Principal.WindowsPrincipal(id).IsInRole(
                        System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        /// <summary>释放尚未被本线程真正持有的 Mutex，再限时等待旧实例退出。</summary>
        private static bool WaitForSingleInstanceMutex(int timeoutMs)
        {
            try { _mutex.ReleaseMutex(); } catch { }
            try { _mutex.Dispose(); } catch { }
            _mutex = null;
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                Thread.Sleep(150);
                bool createdNew = false;
                Mutex next = null;
                try { next = new Mutex(true, MutexName, out createdNew); }
                catch { continue; }
                if (createdNew)
                {
                    _mutex = next;
                    LogStep("elevated handover: mutex acquired");
                    return true;
                }
                try { next.Dispose(); } catch { }
            }
            LogStep("elevated handover: timed out waiting for old instance");
            return false;
        }

        /// <summary>
        /// 互斥量提示「已有实例」时，确认是否真有一个活着的同 exe 进程。
        /// 旧实例可能僵死或卡在启动早期；确认没有活进程时接管，避免「双击没反应」。
        /// 无法判定时保守返回 true（维持转发语义）。
        /// </summary>
        private static bool ExistingProcessAlive()
        {
            try
            {
                var self = Process.GetCurrentProcess();
                string myPath = null;
                try { myPath = self.MainModule.FileName; } catch { }
                var exeName = System.IO.Path.GetFileNameWithoutExtension(self.ProcessName);
                foreach (var p in Process.GetProcessesByName(exeName))
                {
                    try
                    {
                        if (p.Id == self.Id) continue;
                        // 提权下访问其他会话/完整性的 MainModule 可能抛错；只要进程在就算活。
                        if (!string.IsNullOrEmpty(myPath))
                        {
                            string other = null;
                            try { other = p.MainModule.FileName; } catch { }
                            if (other != null &&
                                !string.Equals(other, myPath, StringComparison.OrdinalIgnoreCase))
                                continue;
                        }
                        return true;   // 找到一个活着的同 exe 进程
                    }
                    finally { p.Dispose(); }
                }
                return false;
            }
            catch (Exception ex)
            {
                LogStep("ExistingProcessAlive probe fail: " + ex.Message);
                return true;   // 判不准就按「有实例」处理，避免双开
            }
        }

        /// <summary>事件发不出去时兜底强杀同 exe 的其他实例（--exit-tray/--stop 语义必须达成）。</summary>
        private static void ForceKillExisting()
        {
            try
            {
                var self = Process.GetCurrentProcess();
                var exeName = System.IO.Path.GetFileNameWithoutExtension(self.ProcessName);
                foreach (var p in Process.GetProcessesByName(exeName))
                {
                    try
                    {
                        if (p.Id == self.Id) continue;
                        LogStep("ForceKillExisting: killing pid=" + p.Id);
                        p.Kill();
                    }
                    catch (Exception e) { LogStep("ForceKillExisting pid=" + p.Id + " fail: " + e.Message); }
                    finally { p.Dispose(); }
                }
            }
            catch (Exception e) { LogStep("ForceKillExisting fail: " + e.Message); }
        }

        private static EventWaitHandle CreateSharedEvent(string name, EventResetMode mode)
        {
            try
            {
                var sec = new System.Security.AccessControl.EventWaitHandleSecurity();
                sec.AddAccessRule(new System.Security.AccessControl.EventWaitHandleAccessRule(
                    new System.Security.Principal.SecurityIdentifier(
                        System.Security.Principal.WellKnownSidType.WorldSid, null),
                    System.Security.AccessControl.EventWaitHandleRights.Modify |
                    System.Security.AccessControl.EventWaitHandleRights.Synchronize,
                    System.Security.AccessControl.AccessControlType.Allow));
                bool createdNew;
                var ev = new EventWaitHandle(false, mode, name, out createdNew, sec);
                LogStep("event created: " + name + " new=" + createdNew);
                return ev;
            }
            catch (Exception ex)
            {
                LogStep("CreateSharedEvent " + name + " ACL fail, fallback default: " + ex.Message);
                try { return new EventWaitHandle(false, mode, name); } catch { return null; }
            }
        }

        /** 打开已存在的命名事件并置位（跨进程通知；需要 Modify 权限）。返回是否成功。 */
        private static bool SetNamedEvent(string name, string tag)
        {
            try
            {
                using (var ev = EventWaitHandle.OpenExisting(
                    name, System.Security.AccessControl.EventWaitHandleRights.Modify))
                {
                    ev.Set();
                    LogStep("named event set: " + tag);
                    return true;
                }
            }
            catch (Exception e) { LogStep("named event " + tag + " failed: " + e.Message); return false; }
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

        /// <summary>把旧版分散日志与缓存归位；被占用时跳过，不阻止启动。</summary>
        private static void MigrateDataLayout()
        {
            try
            {
                var data = Path.Combine(_root, "data");
                var logs = Path.Combine(data, "logs");
                var cache = Path.Combine(data, "cache");
                Directory.CreateDirectory(logs);
                Directory.CreateDirectory(cache);
                string[] names = { "panel.log", "agent.log", "launcher.log", "tray-trace.log", "tray-crash.log" };
                foreach (var name in names) MigrateDataFile(Path.Combine(data, name), Path.Combine(logs, name));
                string[] caches = { "mc-versions-cache.json", "mc-cores-cache.json" };
                foreach (var name in caches) MigrateDataFile(Path.Combine(data, name), Path.Combine(cache, name));
                var oldProfile = Path.Combine(data, "webview2-profile");
                var newProfile = Path.Combine(cache, "webview2-profile");
                if (Directory.Exists(oldProfile) && !Directory.Exists(newProfile)) Directory.Move(oldProfile, newProfile);
            }
            catch (Exception ex) { LogStep("data layout migration skipped: " + ex.Message); }
        }

        private static void MigrateDataFile(string source, string target)
        {
            try
            {
                if (!File.Exists(source) || File.Exists(target)) return;
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                try { File.Move(source, target); }
                catch { File.Copy(source, target); }   // 旧进程仍占用时保留源文件
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
