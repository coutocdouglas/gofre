"""Backup do backup: escolha da pasta externa (ex.: Google Drive) e verificação de que ela funciona.

O servidor (app.py) é quem copia os arquivos. Aqui ficam a escolha da pasta, a gravação da
preferência e os avisos ao usuário.
"""
import logging
import os

from . import caminhos

log = logging.getLogger("financeiro")

TEXTO_PERGUNTA_INICIAL = (
    "Para proteger seus dados se o computador pifar, o programa pode copiar os backups "
    "automaticamente para uma pasta do Google Drive.\n\n"
    "Quer escolher essa pasta agora?\n\n"
    "(Você pode fazer isso depois, pelo ícone perto do relógio.)"
)


def tipo_dialogo_pasta(webview):
    """O nome do tipo de caixa de escolha de pasta mudou entre versões do pywebview."""
    arquivo = getattr(webview, "FileDialog", None)
    if arquivo is not None and hasattr(arquivo, "FOLDER"):
        return arquivo.FOLDER
    return webview.FOLDER_DIALOG


def escolher_pasta(janela, webview, inicial=None):
    """Abre a caixa 'escolher pasta'. Retorna o caminho ou None se o usuário cancelou."""
    try:
        resultado = janela.create_file_dialog(tipo_dialogo_pasta(webview), directory=inicial or "")
    except Exception:
        log.exception("Não foi possível abrir a caixa de escolha de pasta")
        return None
    if not resultado:
        return None
    return resultado[0] if isinstance(resultado, (list, tuple)) else resultado


def configurar(pasta, config, pasta_config, financeiro):
    """Ativa a cópia externa. Retorna (ok, detalhe).

    Faz um backup de teste na hora, para o usuário ter certeza de que o arquivo chegou.
    """
    ok, erro = financeiro.testar_pasta_externa(pasta)
    if not ok:
        return False, erro
    config["pasta_backup_externa"] = pasta
    config["backup_externo_perguntado"] = True
    os.environ["FINANCEIRO_BACKUP_EXTRA"] = pasta
    caminhos.salvar_config(pasta_config, config)
    caminho = financeiro.fazer_backup("manual")
    if caminho is None:
        return True, "sem_dados"
    estado = financeiro.ESTADO_BACKUP_EXTERNO
    if estado.get("ok"):
        return True, estado.get("arquivo")
    return False, estado.get("erro") or "erro desconhecido"


def desativar(config, pasta_config):
    config["pasta_backup_externa"] = None
    config["backup_externo_perguntado"] = True
    os.environ["FINANCEIRO_BACKUP_EXTRA"] = ""
    caminhos.salvar_config(pasta_config, config)


def marcar_como_perguntado(config, pasta_config):
    config["backup_externo_perguntado"] = True
    caminhos.salvar_config(pasta_config, config)


def verificar_na_abertura(config, financeiro):
    """Se a pasta externa está configurada mas não dá para gravar nela (Drive fechado, pasta
    apagada...), devolve um texto de aviso. Caso contrário, None."""
    pasta = config.get("pasta_backup_externa")
    if not pasta:
        return None
    ok, _ = financeiro.testar_pasta_externa(pasta)
    if ok:
        return None
    return ("A pasta de backup externa não está acessível agora:\n" + pasta +
            "\n\nVerifique se o Google Drive está aberto. Seus backups locais continuam sendo feitos.")


def texto_do_menu(config):
    pasta = config.get("pasta_backup_externa")
    if not pasta:
        return "Escolher pasta de backup externa (Drive)..."
    return "Backup externo: " + pasta
