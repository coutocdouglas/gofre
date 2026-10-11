"""Gofre — abre o sistema como um programa de Windows.

Como usar:
  py main.py              abre a janela (modo de teste, usa a pasta 'memoria' deste projeto)
  Financeiro.exe          versão empacotada (dados em %APPDATA%\\Financeiro)
  --minimizado            abre direto na bandeja do sistema
"""
import os
import sys
import traceback

# Em modo "sem console" (.exe), stdout/stderr não existem; evita erros ao imprimir.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

from desktop import NOME_PROGRAMA, caminhos
from desktop import windows as win
from desktop.instancia import InstanciaUnica


def registrar_erro_de_abertura(pasta_config):
    """Guarda o erro num arquivo, já que o .exe não tem console para mostrá-lo."""
    try:
        os.makedirs(pasta_config, exist_ok=True)
        caminho = os.path.join(pasta_config, "erro_de_abertura.txt")
        with open(caminho, "w", encoding="utf-8") as f:
            f.write(traceback.format_exc())
        return caminho
    except OSError:
        return None


def main():
    minimizado = "--minimizado" in sys.argv
    pasta_dados = caminhos.pasta_de_dados()
    pasta_config = caminhos.pasta_de_configuracao(pasta_dados)
    pasta_programa = caminhos.pasta_do_programa()
    pasta_assets = os.path.join(getattr(sys, "_MEIPASS", pasta_programa), "assets")

    # 1) Só uma cópia aberta por vez
    instancia = InstanciaUnica()
    if not instancia.tentar_adquirir():
        instancia.avisar_instancia_existente()
        return 0

    # 2) Janela moderna disponível?
    if not win.webview2_instalado():
        win.mostrar_mensagem(
            NOME_PROGRAMA,
            "Falta um componente gratuito da Microsoft (WebView2) para abrir a janela.\n\n"
            "Vou abrir a página de download. Instale, e abra o Financeiro de novo.")
        try:
            import webbrowser
            webbrowser.open(win.LINK_WEBVIEW2)
        except Exception:
            pass
        return 1

    # 3) Dados: só se ainda não existe banco em %APPDATA%, COPIA o banco antigo (se achar)
    os.environ["FINANCEIRO_DATA_DIR"] = pasta_dados
    os.environ["FINANCEIRO_PASTA_PROGRAMA"] = pasta_programa
    caminhos.importar_dados_antigos(pasta_dados, caminhos.candidatos_dados_antigos(pasta_programa))

    # 3b) Preferências (inclui a pasta de backup externa, que o servidor usa desde o 1º backup)
    config = caminhos.carregar_config(pasta_config)
    os.environ["FINANCEIRO_BACKUP_EXTRA"] = config.get("pasta_backup_externa") or ""

    import logging
    import app as financeiro
    from desktop.servidor import aguardar_servidor, iniciar_servidor
    import webview
    from desktop import backup_externo

    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    log = logging.getLogger("financeiro")
    financeiro.preparar_banco()
    financeiro.iniciar_bot_telegram()

    porta = caminhos.porta_livre()
    servidor = iniciar_servidor(financeiro.app, porta)
    if not aguardar_servidor(porta):
        raise RuntimeError("O servidor interno não respondeu.")

    estado = {"janela": None, "bandeja": None, "saindo": False}

    # ---------- ações (usadas pela janela e pela bandeja) ----------
    def mostrar():
        j = estado["janela"]
        if j is None:
            return
        try:
            j.show()
            j.restore()
        except Exception:
            log.exception("Não foi possível mostrar a janela")

    def avisar(texto):
        try:
            if estado["bandeja"] is not None:
                estado["bandeja"].notify(texto, NOME_PROGRAMA)
        except Exception:
            pass

    def fazer_backup_agora():
        try:
            caminho = financeiro.fazer_backup("manual")
            avisar("Backup criado com sucesso." if caminho else "Ainda não há dados para copiar.")
        except Exception:
            log.exception("Falha no backup manual")
            avisar("Não foi possível criar o backup.")

    def abrir_pasta_dados():
        win.abrir_pasta(pasta_dados)

    # ---------- backup externo (cópia dos backups para o Google Drive) ----------
    def escolher_backup_externo():
        mostrar()
        pasta = backup_externo.escolher_pasta(
            estado["janela"], webview, inicial=config.get("pasta_backup_externa"))
        if not pasta:
            backup_externo.marcar_como_perguntado(config, pasta_config)
            return
        ok, detalhe = backup_externo.configurar(pasta, config, pasta_config, financeiro)
        atualizar_menu()
        if ok and detalhe == "sem_dados":
            avisar("Pasta de backup externa definida.")
        elif ok:
            avisar("Pronto! Backup de teste copiado para a pasta escolhida.")
        else:
            win.mostrar_mensagem(
                NOME_PROGRAMA,
                "Não consegui gravar na pasta escolhida:\n" + pasta + "\n\nDetalhe: " + str(detalhe) +
                "\n\nEscolha outra pasta pelo ícone perto do relógio.")

    def desativar_backup_externo():
        backup_externo.desativar(config, pasta_config)
        atualizar_menu()
        avisar("Os backups não serão mais copiados para fora.")

    def backup_externo_ativo():
        return bool(config.get("pasta_backup_externa"))

    def texto_backup_externo():
        return backup_externo.texto_do_menu(config)

    def ao_iniciar():
        """Roda depois que a janela abre: dá o visual do Gofre à moldura, avisa se a pasta externa sumiu, ou pergunta na 1ª vez."""
        try:
            win.estilizar_janela(NOME_PROGRAMA)
        except Exception:
            pass
        try:
            if config.get("pasta_backup_externa"):
                aviso = backup_externo.verificar_na_abertura(config, financeiro)
                if aviso:
                    win.mostrar_mensagem(NOME_PROGRAMA, aviso)
            elif not config.get("backup_externo_perguntado") and not minimizado:
                import time
                time.sleep(2)
                quer = True
                try:
                    quer = bool(estado["janela"].create_confirmation_dialog(
                        NOME_PROGRAMA, backup_externo.TEXTO_PERGUNTA_INICIAL))
                except Exception:
                    log.exception("Não foi possível mostrar a pergunta inicial")
                if quer:
                    escolher_backup_externo()
                else:
                    backup_externo.marcar_como_perguntado(config, pasta_config)
        except Exception:
            log.exception("Falha na verificação do backup externo")

    def inicio_ativo():
        return win.inicio_com_windows_ativo()

    def alternar_inicio():
        if not caminhos.empacotado():
            avisar("Disponível apenas no programa instalado (.exe).")
            return
        try:
            win.definir_inicio_com_windows(not win.inicio_com_windows_ativo(), sys.executable)
        except Exception:
            log.exception("Falha ao alterar início com o Windows")
        atualizar_menu()

    def bandeja_ativa():
        return bool(config["fechar_para_bandeja"])

    def alternar_bandeja():
        config["fechar_para_bandeja"] = not config["fechar_para_bandeja"]
        caminhos.salvar_config(pasta_config, config)
        atualizar_menu()

    def atualizar_menu():
        try:
            if estado["bandeja"] is not None:
                estado["bandeja"].update_menu()
        except Exception:
            pass

    def sair():
        estado["saindo"] = True
        try:
            if estado["bandeja"] is not None:
                estado["bandeja"].stop()
        except Exception:
            pass
        try:
            if estado["janela"] is not None:
                estado["janela"].destroy()
        except Exception:
            log.exception("Falha ao fechar a janela")

    # ---------- bandeja do sistema ----------
    from desktop.bandeja import criar_bandeja
    estado["bandeja"] = criar_bandeja(pasta_assets, {
        "mostrar": mostrar, "backup": fazer_backup_agora, "pasta_dados": abrir_pasta_dados,
        "sair": sair, "alternar_inicio": alternar_inicio, "inicio_ativo": inicio_ativo,
        "alternar_bandeja": alternar_bandeja, "bandeja_ativa": bandeja_ativa,
        "texto_backup_externo": texto_backup_externo, "escolher_backup_externo": escolher_backup_externo,
        "desativar_backup_externo": desativar_backup_externo, "backup_externo_ativo": backup_externo_ativo,
    })
    instancia.escutar(mostrar)  # outra cópia aberta => mostra esta janela

    # ---------- janela ----------
    webview.settings["ALLOW_DOWNLOADS"] = True  # necessário para "Gerar Extrato (PNG)"
    janela = webview.create_window(
        NOME_PROGRAMA,
        f"http://127.0.0.1:{porta}/",
        width=int(config["largura"]), height=int(config["altura"]),
        x=config["x"], y=config["y"],
        min_size=(1000, 650),
        background_color="#181311",
        hidden=bool(minimizado and estado["bandeja"] is not None),
    )
    estado["janela"] = janela

    def guardar_posicao():
        try:
            if janela.x is not None and janela.x > -10000 and janela.width > 400:
                config.update({"largura": janela.width, "altura": janela.height, "x": janela.x, "y": janela.y})
                caminhos.salvar_config(pasta_config, config)
        except Exception:
            pass

    def ao_fechar():
        guardar_posicao()
        if estado["saindo"]:
            return True
        if config["fechar_para_bandeja"] and estado["bandeja"] is not None:
            janela.hide()
            return False  # cancela o fechamento: o programa continua na bandeja
        estado["saindo"] = True
        return True

    janela.events.closing += ao_fechar

    icone = os.path.join(pasta_assets, "icone.ico")
    try:
        webview.start(ao_iniciar, icon=icone if os.path.exists(icone) else None)
    finally:
        # Chegou aqui = janela destruída (Sair). Encerramento limpo:
        try:
            if estado["bandeja"] is not None:
                estado["bandeja"].stop()
        except Exception:
            pass
        try:
            financeiro.bot_telegram.parar(esperar=False)
        except Exception:
            pass
        instancia.liberar()
        try:
            servidor.shutdown()
        except Exception:
            pass
        log.info("Programa encerrado.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:
        caminho_erro = registrar_erro_de_abertura(
            caminhos.pasta_de_configuracao(caminhos.pasta_de_dados()))
        win.mostrar_mensagem(
            NOME_PROGRAMA,
            "O programa encontrou um erro e precisou fechar.\n\n"
            + (f"Os detalhes foram salvos em:\n{caminho_erro}\n\nEnvie esse arquivo para suporte."
               if caminho_erro else "Não foi possível salvar os detalhes do erro."))
        sys.exit(1)
