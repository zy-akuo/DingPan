; Inno Setup script — 需安装 Inno Setup 后编译
; 先运行 packaging\prepare-resources.ps1

#define MyAppName "钉盘"
#define MyAppVersion "0.2.0"
#define MyAppPublisher "DingPan"
#define MyAppExeName "DingPan.bat"

[Setup]
AppId={{A8C3E2F1-9D4B-4F2A-8C71-DingPan0001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\DingPan
DefaultGroupName={#MyAppName}
OutputDir=out
OutputBaseFilename=DingPan-Setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标:"

[Files]
Source: "out\DingPan\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch DingPan"; Flags: nowait postinstall skipifsilent

