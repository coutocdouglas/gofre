"""Recursos específicos do Windows. Tudo aqui é seguro de importar em qualquer sistema."""
import os
import sys

NOME_ATALHO_INICIO = "Financeiro2026PRO"
CHAVE_INICIO = r"Software\Microsoft\Windows\CurrentVersion\Run"
LINK_WEBVIEW2 = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
_GUIDS_WEBVIEW2 = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


def e_windows():
    return sys.platform.startswith("win")


# ---------------- Iniciar com o Windows ----------------

def comando_de_inicio(caminho_exe):
    """Linha gravada no registro: abre o programa já minimizado na bandeja."""
    return f'"{caminho_exe}" --minimizado'


def inicio_com_windows_ativo():
    if not e_windows():
        return False
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, CHAVE_INICIO) as chave:
            winreg.QueryValueEx(chave, NOME_ATALHO_INICIO)
            return True
    except OSError:
        return False


def definir_inicio_com_windows(ativar, caminho_exe=None):
    """Liga/desliga a abertura automática. Só funciona no Windows e no .exe."""
    if not e_windows():
        return False
    import winreg
    caminho_exe = caminho_exe or sys.executable
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, CHAVE_INICIO, 0, winreg.KEY_SET_VALUE) as chave:
        if ativar:
            winreg.SetValueEx(chave, NOME_ATALHO_INICIO, 0, winreg.REG_SZ, comando_de_inicio(caminho_exe))
        else:
            try:
                winreg.DeleteValue(chave, NOME_ATALHO_INICIO)
            except FileNotFoundError:
                pass
    return True


# ---------------- Janela moderna (WebView2) ----------------

def webview2_instalado():
    """O Windows 10/11 atual já traz o WebView2. Em máquinas antigas pode faltar."""
    if not e_windows():
        return True
    try:
        import winreg
    except ImportError:
        return True
    locais = [
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{_GUIDS_WEBVIEW2}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{_GUIDS_WEBVIEW2}"),
        (winreg.HKEY_CURRENT_USER, rf"Software\Microsoft\EdgeUpdate\Clients\{_GUIDS_WEBVIEW2}"),
    ]
    for raiz, caminho in locais:
        try:
            with winreg.OpenKey(raiz, caminho) as chave:
                versao, _ = winreg.QueryValueEx(chave, "pv")
                if versao and versao != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


# ---------------- Mensagens e pastas ----------------

def mostrar_mensagem(titulo, texto):
    """Caixa de mensagem simples (para erros quando não há console)."""
    if e_windows():
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, texto, titulo, 0x10)
            return
        except Exception:
            pass
    print(f"[{titulo}] {texto}")


def abrir_pasta(caminho):
    os.makedirs(caminho, exist_ok=True)
    if e_windows():
        os.startfile(caminho)  # noqa: S606 (abre no Explorer)
    elif sys.platform == "darwin":
        os.system(f'open "{caminho}"')
    else:
        os.system(f'xdg-open "{caminho}" >/dev/null 2>&1 &')


def _colorref(hex_):
    h = hex_.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return r | (g << 8) | (b << 16)


def estilizar_janela(titulo, barra="#1B1412", texto="#EFE6D8", borda="#3A2F2A"):
    """Deixa a moldura do Windows 11 no visual do Gofre: barra de título escura (cor do fundo), texto creme,
    borda discreta e cantos arredondados. No Windows 10 o que não for suportado é ignorado. Nunca derruba o programa."""
    if not e_windows():
        return False
    try:
        import ctypes
        from ctypes import wintypes
        import time
        user32 = ctypes.windll.user32
        user32.FindWindowW.restype = wintypes.HWND
        hwnd = None
        for _ in range(40):                       # a janela pode demorar um instante para existir
            hwnd = user32.FindWindowW(None, titulo)
            if hwnd:
                break
            time.sleep(0.25)
        if not hwnd:
            return False
        dwm = ctypes.windll.dwmapi

        def definir(atributo, valor):
            v = ctypes.c_int(valor)
            dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), ctypes.c_uint(atributo), ctypes.byref(v), ctypes.sizeof(v))

        definir(20, 1)                            # modo escuro da barra de título
        definir(33, 2)                            # cantos arredondados (Windows 11)
        definir(35, _colorref(barra))             # cor da barra de título (Windows 11)
        definir(36, _colorref(texto))             # cor do texto da barra
        definir(34, _colorref(borda))             # cor da borda da janela
        return True
    except Exception:
        return False
