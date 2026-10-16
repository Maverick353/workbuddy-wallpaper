; ============================================================================
;  workbuddy-wallpaper · Inno Setup 打包脚本
; ----------------------------------------------------------------------------
;  面向"只会双击"的普通用户：给他们一个真正的 .exe 安装包（下一步下一步就完了），
;  而不是一个 .cmd（SmartScreen 对未签名脚本的弹窗比 .exe 更吓人）。
;
;  构建（需要本机装有 Inno Setup 6）：
;      installer\build-installer.cmd
;  或手动：
;      "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer\setup.iss
;
;  ⚠️ 当前开发机上**没有装 ISCC**，所以本文件尚未实际编译验证过。
;     这意味着它是"按规范写好、未冒烟"的状态 —— 第一次构建时请照上面的路径先装 Inno Setup 6。
;
;  设计取向：
;    · 装进 %LOCALAPPDATA%\Programs\...（**不需要管理员**，PrivilegesRequired=lowest）
;    · 装完在开始菜单放一个「workbuddy-wallpaper」项 → 指向 启动.cmd
;    · postinstall 跑一次 install.cmd（自己找 Node、装成技能、注册自启、
;      **并把看门狗在后台拉起来** —— 用户不用等下次登录，装完就能看到壁纸）
;    · 卸载走 uninstall.cmd（完整顺序：摘注入 → 停服务 → 停看门狗 → 撤自启 → 删目录 → 问数据目录）
; ============================================================================

#define MyAppName "workbuddy-wallpaper"
#define MyAppVersion "1.1.3"
#define MyAppPublisher "Maverick353"
#define MyAppURL "https://github.com/Maverick353/workbuddy-wallpaper"
#define MyAppExeName "启动.cmd"

[Setup]
AppId={{8F3A6C21-7B4E-4A9D-9C3E-2A5F1D6B7C80}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=workbuddy-wallpaper-setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; 让 .exe 在「文件属性」里能看到版本 —— 实测 v1.1.1 的安装包**版本资源是空的**
; （VerQueryValue 读 ProductVersion/FileVersion 全取不到，SmartScreen/兼容性判断会少一条信息）。
; VersionInfoVersion 要求 4 段数字，所以补一个 .0。
VersionInfoVersion={#MyAppVersion}.0
VersionInfoProductVersion={#MyAppVersion}.0
VersionInfoProductName={#MyAppName}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} - WorkBuddy 壁纸引擎安装包
VersionInfoCopyright=AGPL-3.0-or-later
; 未签名 → 不声明 signed；用户会看到 SmartScreen 提示（README / 下载页有说明）

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
; ⚠️ Inno Setup 6 **不自带** ChineseSimplified.isl（中文向导是社区翻译，要单独下载放进
;    <Inno 安装目录>\Languages\）。CI 上就因为这个文件不存在，第 49 行直接编译失败。
;    所以这里做成「有就用、没有就只出英文向导」—— 缺一个翻译文件不该让整个打包崩掉。
;    （想装中文向导：去 Inno Setup 官网的 Translations 页下载 ChineseSimplified.isl，
;      放到 C:\Program Files (x86)\Inno Setup 6\Languages\ 即可，无需改本文件。）
#if FileExists("C:\Program Files (x86)\Inno Setup 6\Languages\ChineseSimplified.isl")
Name: "chinese"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: checkedonce

[Files]
; 整包拷进去（排除仓库/开发产物）。注意 renderer\ 是随包的第三方渲染器，必须带上。
Source: "..\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; \
  Excludes: ".git,.git\*,dist\*,dist,_tmp\*,_tmp,.backup-*,.github\*,docs\*,*.log,.gitignore,.gitattributes,推广文案-*.md,优化计划-*.md"

[Icons]
Name: "{group}\启动 {#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{app}\uninstall.cmd"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; 装完立刻跑一次配置：找 Node → 装成技能 → 注册自启 → **后台拉起看门狗（隐藏窗口）**
;   → 检测调试端口 → 没有就提出"帮你改快捷方式"。
; 用 nowait + 让控制台可见，用户能看懂发生了什么。
;
; 为什么没有第二个「现在就启动壁纸」勾选项：
;   install.cmd 已经用 `companion.js --start-detached` 在后台把服务拉起来了，不需要用户再勾。
;   而那个勾选项跑的是 启动.cmd（前景控制台），会和后台看门狗抢单实例锁 →
;   结果只弹一个窗口写"已在运行"，纯属给用户添困惑。
Filename: "{app}\install.cmd"; Description: "立刻完成配置（推荐）"; \
  Flags: postinstall nowait skipifsilent

[UninstallRun]
; 卸载前跑完整卸载顺序（摘注入 / 停服务 / 停看门狗 / 撤自启 / 删安装目录 / 问数据目录）
Filename: "{app}\uninstall.cmd"; Flags: runhidden waituntilterminated; RunOnceId: "WdUninstall"

[UninstallDelete]
; 兜底：卸载后残留的临时产物
Type: filesandordirs; Name: "{app}\dist"
