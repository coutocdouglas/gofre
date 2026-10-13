; Receita do instalador (Inno Setup 6). Usada pelo construir_instalador.bat
#define NomeApp "Gofre"
#define Versao "2.6.1"

[Setup]
AppId={{B7C5E8A2-3F4D-4E6B-9A1C-5D2F8E7A4B90}
AppName={#NomeApp}
AppVersion={#Versao}
DefaultDirName={localappdata}\Programs\Financeiro
DefaultGroupName={#NomeApp}
PrivilegesRequired=lowest
OutputDir=instalador
OutputBaseFilename=Instalar_Financeiro_{#Versao}
SetupIconFile=assets\icone.ico
UninstallDisplayIcon={app}\Financeiro.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na Area de Trabalho"; GroupDescription: "Atalhos:"
Name: "iniciarcomwindows"; Description: "Abrir automaticamente ao ligar o computador"; GroupDescription: "Opcoes:"; Flags: unchecked

[Files]
Source: "dist\Financeiro\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Atalhos com o nome antigo (o programa agora se chama Gofre)
Type: files; Name: "{autodesktop}\Financeiro 2026 PRO.lnk"
Type: filesandordirs; Name: "{userprograms}\Financeiro 2026 PRO"

[Icons]
Name: "{group}\{#NomeApp}"; Filename: "{app}\Financeiro.exe"
Name: "{autodesktop}\{#NomeApp}"; Filename: "{app}\Financeiro.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Financeiro2026PRO"; ValueData: """{app}\Financeiro.exe"" --minimizado"; Flags: uninsdeletevalue; Tasks: iniciarcomwindows

[Run]
Filename: "{app}\Financeiro.exe"; Description: "Abrir o Gofre agora"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Financeiro.exe"; Flags: nowait; Check: ReabrirPedido

; Importante: os DADOS ficam em %APPDATA%\Financeiro e NAO sao apagados ao desinstalar ou atualizar.

[Code]
{ O proprio Gofre chama o instalador com /reabrir=1 ao se atualizar sozinho: no fim, ele abre de novo. }
function ReabrirPedido: Boolean;
begin
  Result := ExpandConstant('{param:reabrir|0}') = '1';
end;

{ Ao instalar por cima de uma versao aberta (ela fica na bandeja do relogio), fecha o programa antes de trocar os arquivos.
  Os dados nao sao afetados: ficam em outra pasta e o banco grava tudo de forma segura. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Codigo: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM Financeiro.exe /F', '', SW_HIDE, ewWaitUntilTerminated, Codigo);
  Sleep(800);
  Result := '';
end;

