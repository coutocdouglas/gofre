"""Ícone perto do relógio (bandeja do sistema). Se algo falhar, o programa segue sem ele."""
import os

from . import NOME_PROGRAMA


def carregar_imagem(pasta_assets):
    from PIL import Image
    return Image.open(os.path.join(pasta_assets, "icone.png"))


def criar_bandeja(pasta_assets, acoes):
    """Cria o ícone. 'acoes' é um dicionário de funções:
       mostrar, backup, pasta_dados, sair, texto_backup_externo, escolher_backup_externo,
       desativar_backup_externo, backup_externo_ativo,
       alternar_inicio, inicio_ativo, alternar_bandeja, bandeja_ativa
    Retorna o ícone (já rodando em segundo plano) ou None se não for possível.
    """
    try:
        import pystray
        from pystray import Menu, MenuItem as Item

        menu = Menu(
            Item("Abrir o Gofre", lambda icone, item: acoes["mostrar"](), default=True),
            Menu.SEPARATOR,
            Item("Fazer backup agora", lambda icone, item: acoes["backup"]()),
            Item("Abrir pasta de dados", lambda icone, item: acoes["pasta_dados"]()),
            Item(lambda item: acoes["texto_backup_externo"](),
                 lambda icone, item: acoes["escolher_backup_externo"]()),
            Item("Parar de copiar backups para fora",
                 lambda icone, item: acoes["desativar_backup_externo"](),
                 visible=lambda item: acoes["backup_externo_ativo"]()),
            Menu.SEPARATOR,
            Item("Iniciar com o Windows",
                 lambda icone, item: acoes["alternar_inicio"](),
                 checked=lambda item: acoes["inicio_ativo"]()),
            Item("Fechar a janela envia para a bandeja",
                 lambda icone, item: acoes["alternar_bandeja"](),
                 checked=lambda item: acoes["bandeja_ativa"]()),
            Menu.SEPARATOR,
            Item("Sair", lambda icone, item: acoes["sair"]()),
        )
        icone = pystray.Icon("financeiro", carregar_imagem(pasta_assets), NOME_PROGRAMA, menu)
        icone.run_detached()
        return icone
    except Exception:
        import logging
        logging.getLogger("financeiro").exception("Bandeja do sistema indisponível")
        return None
