from flask import Flask, render_template, request, jsonify, g
import os
import sqlite3
import json
import re
import sys
import webbrowser
import shutil
import logging
import time
from datetime import datetime
from threading import Timer, Lock, Thread

# Quando empacotado (.exe), os arquivos da tela ficam dentro da pasta temporária do PyInstaller.
_BASE_RECURSOS = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
app = Flask(
    __name__,
    template_folder=os.path.join(_BASE_RECURSOS, "templates"),
    static_folder=os.path.join(_BASE_RECURSOS, "static"),
)

# Desabilitar cache para garantir que o browser sempre carrega a versão mais recente
@app.after_request
def no_cache(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    return response

# ============================================================
# CONFIGURAÇÃO DO BANCO DE DADOS
# O banco fica num único arquivo "financeiro.db"
# Para fazer backup: basta copiar esse arquivo!
# ============================================================
# O caminho é sempre relativo à pasta deste arquivo (e não à pasta de onde o
# programa foi iniciado), para nunca criar um banco "vazio" em outro lugar.
# A variável FINANCEIRO_DATA_DIR permite apontar outra pasta (usada nos testes).
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _pasta_dados_padrao():
    """Os dados ficam em %APPDATA%\\Financeiro\\memoria (fora da pasta do programa), tanto no
    .exe quanto nos modos de teste/.bat. Assim existe UM só banco, e mover ou reinstalar o
    programa nunca afeta os dados. Fora do Windows (desenvolvimento), usa a pasta 'memoria' local."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        return os.path.join(appdata, "Financeiro", "memoria")
    return os.path.join(BASE_DIR, "memoria")


PASTA_MEMORIA = os.environ.get("FINANCEIRO_DATA_DIR") or _pasta_dados_padrao()
BANCO_DE_DADOS = os.path.join(PASTA_MEMORIA, "financeiro.db")
PASTA_BACKUPS = os.path.join(PASTA_MEMORIA, "backups")


def pasta_config():
    """Preferências e senhas ficam ao lado da pasta 'memoria' (nunca dentro dela)."""
    return os.environ.get("FINANCEIRO_CONFIG_DIR") or os.path.dirname(PASTA_MEMORIA)


def pasta_programa():
    return os.environ.get("FINANCEIRO_PASTA_PROGRAMA") or BASE_DIR

PASTA_LOGS = os.path.join(PASTA_MEMORIA, "logs")

for _pasta in (PASTA_MEMORIA, PASTA_BACKUPS, PASTA_LOGS):
    os.makedirs(_pasta, exist_ok=True)

logging.basicConfig(
    filename=os.path.join(PASTA_LOGS, "app.log"),
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    encoding="utf-8",
)
log = logging.getLogger("financeiro")


# ============================================================
# BACKUP AUTOMÁTICO
# Gera cópias consistentes do banco (API de backup do SQLite) em
# memoria/backups/. Cada tipo tem seu próprio limite de retenção,
# para que backups frequentes não apaguem os diários.
#   abertura : ao iniciar o programa
#   diario   : primeira gravação de cada dia
#   auto     : antes de gravar, se o último backup tem mais de 5 min
#   reducao  : antes de uma gravação que reduz muitos registros
# ============================================================
RETENCAO_BACKUPS = {"abertura": 15, "diario": 30, "auto": 20, "reducao": 30, "manual": 30}
INTERVALO_AUTO_SEGUNDOS = 300
_lock_backup = Lock()

# ---------- Backup do backup (pasta externa, ex.: Google Drive) ----------
# A pasta é escolhida pelo usuário no programa e chega aqui pela variável de ambiente
# FINANCEIRO_BACKUP_EXTRA. Só são copiados backups JÁ PRONTOS (arquivos fechados), nunca o banco
# em uso, o que evita corrupção por sincronização. Qualquer falha é registrada e avisada, mas
# nunca impede o backup local nem o uso do programa.
ESTADO_BACKUP_EXTERNO = {"configurado": False, "ok": None, "erro": None, "arquivo": None}


def pasta_backup_externa():
    pasta = (os.environ.get("FINANCEIRO_BACKUP_EXTRA") or "").strip()
    return pasta or None


def testar_pasta_externa(pasta):
    """Confere se dá para gravar na pasta. Retorna (ok, mensagem)."""
    try:
        os.makedirs(pasta, exist_ok=True)
        teste = os.path.join(pasta, ".teste_gravacao.tmp")
        with open(teste, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(teste)
        return True, "ok"
    except Exception as e:
        return False, str(e)


def _copiar_para_externo(caminho_backup, tipo):
    pasta = pasta_backup_externa()
    ESTADO_BACKUP_EXTERNO["configurado"] = bool(pasta)
    if not pasta:
        return None
    try:
        os.makedirs(pasta, exist_ok=True)
        destino = os.path.join(pasta, os.path.basename(caminho_backup))
        temporario = destino + ".tmp"
        shutil.copy2(caminho_backup, temporario)
        os.replace(temporario, destino)  # só aparece com o nome final quando está completo
        # Retenção na pasta externa: mesmos limites de cada tipo
        prefixo = f"financeiro_{tipo}_"
        limite = RETENCAO_BACKUPS.get(tipo, 20)
        antigos = sorted(f for f in os.listdir(pasta) if f.startswith(prefixo) and f.endswith(".db"))[:-limite]
        for nome in antigos:
            try:
                os.remove(os.path.join(pasta, nome))
            except OSError:
                pass
        ESTADO_BACKUP_EXTERNO.update({"ok": True, "erro": None, "arquivo": destino})
        log.info("Backup copiado para a pasta externa: %s", destino)
        return destino
    except Exception as e:
        ESTADO_BACKUP_EXTERNO.update({"ok": False, "erro": str(e), "arquivo": None})
        log.exception("Falha ao copiar o backup para a pasta externa (%s)", pasta)
        return None


def _backups_do_tipo(tipo):
    prefixo = f"financeiro_{tipo}_"
    return sorted(
        f for f in os.listdir(PASTA_BACKUPS)
        if f.startswith(prefixo) and f.endswith(".db")
    )


def _idade_ultimo_backup():
    """Segundos desde o backup mais recente de qualquer tipo (None se não há)."""
    arquivos = [os.path.join(PASTA_BACKUPS, f) for f in os.listdir(PASTA_BACKUPS) if f.endswith(".db")]
    if not arquivos:
        return None
    return time.time() - max(os.path.getmtime(a) for a in arquivos)


def fazer_backup(tipo="manual"):
    """Cria um backup do banco. Retorna o caminho, ou None se não havia o que copiar."""
    if not os.path.exists(BANCO_DE_DADOS) or os.path.getsize(BANCO_DE_DADOS) == 0:
        return None
    with _lock_backup:
        carimbo = datetime.now().strftime("%Y%m%d_%H%M%S")
        destino = os.path.join(PASTA_BACKUPS, f"financeiro_{tipo}_{carimbo}.db")
        if os.path.exists(destino):
            return destino
        origem = sqlite3.connect(BANCO_DE_DADOS)
        copia = sqlite3.connect(destino)
        try:
            origem.backup(copia)
        finally:
            copia.close()
            origem.close()
        # Retenção: mantém só os N mais recentes de cada tipo
        limite = RETENCAO_BACKUPS.get(tipo, 20)
        antigos = _backups_do_tipo(tipo)[:-limite]
        for nome in antigos:
            try:
                os.remove(os.path.join(PASTA_BACKUPS, nome))
            except OSError:
                pass
        log.info("Backup criado (%s): %s", tipo, os.path.basename(destino))
        _copiar_para_externo(destino, tipo)
        return destino


def backup_antes_de_gravar():
    """Chamado antes de qualquer gravação: garante o backup diário e o automático."""
    try:
        hoje = datetime.now().strftime("%Y%m%d")
        if not any(f.startswith(f"financeiro_diario_{hoje}") for f in _backups_do_tipo("diario")):
            fazer_backup("diario")
            return
        idade = _idade_ultimo_backup()
        if idade is None or idade > INTERVALO_AUTO_SEGUNDOS:
            fazer_backup("auto")
    except Exception:
        log.exception("Falha ao criar backup antes de gravar")


# ============================================================
# TRAVA CONTRA REGRAVAÇÃO DESTRUTIVA
# Toda gravação do frontend substitui a tabela inteira. Se o navegador
# estiver com um estado antigo/incompleto, isso apagaria dados em silêncio.
# A trava recusa a gravação (HTTP 409) quando ela reduziria muito os
# registros, a menos que o frontend reenvie com o cabeçalho
# "X-Confirmar-Reducao: 1" (isso só acontece depois de o usuário confirmar).
# ============================================================
LIMITE_REDUCAO = 0.70       # recusa se sobrar menos de 70% dos registros
MINIMO_PARA_PROTEGER = 5    # só protege tabelas com pelo menos 5 registros
MINIMO_ZERAR = 3            # zerar uma tabela com 3+ registros também exige confirmação


def verificar_reducao(con, tabela, qtd_nova):
    """Retorna uma resposta 409 se a gravação for suspeita; None se pode seguir."""
    if request.headers.get("X-Confirmar-Reducao") == "1":
        return None
    qtd_atual = con.execute(f"SELECT COUNT(*) FROM {tabela}").fetchone()[0]
    reduz_muito = qtd_atual >= MINIMO_PARA_PROTEGER and qtd_nova < qtd_atual * LIMITE_REDUCAO
    zera = qtd_atual >= MINIMO_ZERAR and qtd_nova == 0
    if reduz_muito or zera:
        log.warning("Gravação bloqueada em %s: %s -> %s registros", tabela, qtd_atual, qtd_nova)
        try:
            fazer_backup("reducao")
        except Exception:
            log.exception("Falha no backup de redução")
        resposta = jsonify({
            "erro": "reducao_drastica",
            "tabela": tabela,
            "antes": qtd_atual,
            "depois": qtd_nova,
        })
        resposta.status_code = 409
        return resposta
    return None


# ---------- Versão dos dados (protege contra tela desatualizada) ----------
# A tela guarda uma cópia dos dados. Se outra origem gravar (ex.: o bot do Telegram) e a tela,
# sem saber, gravar por cima com a cópia velha, o lançamento novo seria apagado. Por isso o servidor
# numera as gravações: a tela envia a versão que conhece (cabeçalho X-Versao); se estiver velha,
# a gravação é recusada (HTTP 409 "desatualizado") e a tela recarrega os dados antes de continuar.
_versao_dados = {"n": int(time.time())}
_lock_versao = Lock()


def _rota_de_dados(caminho):
    return caminho in TABELAS_POR_ROTA or caminho.startswith("/api/historico/")


@app.before_request
def checar_versao_dos_dados():
    if request.method == "POST" and request.path in TABELAS_POR_ROTA:
        enviada = request.headers.get("X-Versao")
        if enviada is not None and enviada != str(_versao_dados["n"]):
            return jsonify({"erro": "desatualizado"}), 409


@app.after_request
def carimbar_versao(response):
    if request.method == "POST" and _rota_de_dados(request.path) and response.status_code < 300:
        with _lock_versao:
            _versao_dados["n"] += 1
    response.headers["X-Versao"] = str(_versao_dados["n"])
    return response


@app.route("/api/versao", methods=["GET"])
def get_versao():
    return jsonify({"versao": str(_versao_dados["n"])})


@app.before_request
def antes_de_cada_requisicao():
    if request.method == "POST" and request.path.startswith("/api/"):
        backup_antes_de_gravar()


class _Conexao(sqlite3.Connection):
    """Conexão que FECHA ao sair do 'with' (a padrão do Python só confirma e deixa o arquivo preso no Windows)."""
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def conectar():
    """Abre uma conexão com o banco. O 'with' confirma e fecha automaticamente."""
    con = sqlite3.connect(BANCO_DE_DADOS, factory=_Conexao)
    con.row_factory = sqlite3.Row  # Permite acessar colunas pelo nome (ex: row["nome"])
    return con


def inicializar_db():
    """
    Cria todas as tabelas se ainda não existirem.
    É seguro rodar isso toda vez que o servidor inicia — ele não apaga dados existentes.
    """
    with conectar() as con:
        cur = con.cursor()

        # TABELA: Pessoas
        cur.execute("""
            CREATE TABLE IF NOT EXISTS pessoas (
                id      TEXT PRIMARY KEY,
                nome    TEXT NOT NULL,
                tipo    TEXT NOT NULL DEFAULT 'secundaria'
            )
        """)

        # TABELA: Cartões
        cur.execute("""
            CREATE TABLE IF NOT EXISTS cartoes (
                id          TEXT PRIMARY KEY,
                nome        TEXT NOT NULL,
                vencimento  TEXT NOT NULL,
                cor         TEXT NOT NULL DEFAULT '#8ab4f8',
                fechamento  TEXT NOT NULL DEFAULT ''
            )
        """)

        # TABELA: Categorias
        cur.execute("""
            CREATE TABLE IF NOT EXISTS categorias (
                id   TEXT PRIMARY KEY,
                nome TEXT NOT NULL
            )
        """)

        # TABELA: Subcategorias (filhas das categorias)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS subcategorias (
                id       TEXT PRIMARY KEY,
                nome     TEXT NOT NULL,
                cat_id   TEXT NOT NULL,
                FOREIGN KEY (cat_id) REFERENCES categorias(id) ON DELETE CASCADE
            )
        """)

        # TABELA: Regras de Entradas Fixas (ex: Salário mensal)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS regras_fixas (
                id     TEXT PRIMARY KEY,
                desc   TEXT NOT NULL,
                valor  REAL NOT NULL,
                dia    TEXT NOT NULL,
                inicio TEXT NOT NULL
            )
        """)

        # TABELA: Transações de Entradas (instâncias reais de cada mês)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS transacoes (
                id           TEXT PRIMARY KEY,
                desc         TEXT NOT NULL,
                valor        REAL NOT NULL,
                data         TEXT NOT NULL,
                origem_regra TEXT  -- NULL = avulso; ID = gerado por regra fixa
            )
        """)

        # TABELA: Faturas de Cartão (cada parcela é uma linha)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS faturas (
                id              TEXT PRIMARY KEY,
                id_compra_pai   TEXT NOT NULL,
                cartao_id       TEXT NOT NULL,
                desc            TEXT NOT NULL,
                data_compra     TEXT NOT NULL,
                mes_fatura      TEXT NOT NULL,
                valor_parcela   REAL NOT NULL,
                parcela_atual   INTEGER NOT NULL,
                total_parcelas  INTEGER NOT NULL,
                cat_id          TEXT,
                subcat_id       TEXT,
                divisao         TEXT NOT NULL DEFAULT '[]',
                fechamento_dia  TEXT NOT NULL DEFAULT '',
                data_inicio     TEXT NOT NULL DEFAULT ''
            )
        """)

        # TABELA: Regras de classificação da importação de faturas em PDF
        cur.execute("""
            CREATE TABLE IF NOT EXISTS regras_importacao (
                id        TEXT PRIMARY KEY,
                padrao    TEXT NOT NULL UNIQUE,
                nome      TEXT NOT NULL,
                cat_id    TEXT,
                subcat_id TEXT,
                divisao   TEXT NOT NULL DEFAULT '[]',
                usos      INTEGER NOT NULL DEFAULT 0,
                criado_em TEXT NOT NULL,
                fixo      INTEGER NOT NULL DEFAULT 0
            )
        """)

        # TABELA: PDFs de fatura já importados (para avisar se importar o mesmo arquivo de novo)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS importacoes (
                id         TEXT PRIMARY KEY,
                hash       TEXT NOT NULL,
                arquivo    TEXT,
                emissor    TEXT,
                vencimento TEXT,
                total      REAL,
                itens      INTEGER NOT NULL DEFAULT 0,
                ids        TEXT NOT NULL DEFAULT '[]',
                criado_em  TEXT NOT NULL
            )
        """)

        # TABELA: Regras de Gastos Fixos (ex: Aluguel, Academia)
        # Funciona igual às regras de entradas fixas: define o padrão mensal.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS regras_gastos_fixos (
                id        TEXT PRIMARY KEY,
                desc      TEXT NOT NULL,
                valor     REAL NOT NULL,
                dia       TEXT NOT NULL,
                cat_id    TEXT,
                subcat_id TEXT,
                inicio    TEXT NOT NULL,
                divisao   TEXT NOT NULL DEFAULT '[]',
                meses_pulados TEXT NOT NULL DEFAULT '[]'
            )
        """)

        # TABELA: Gastos Pontuais (Dinheiro/Pix) — instâncias reais por mês
        # origem_regra: NULL = avulso; ID = gerado por regra de gasto fixo
        # valor_editado: 1 = o usuário ajustou o valor neste mês específico
        cur.execute("""
            CREATE TABLE IF NOT EXISTS gastos_pontuais (
                id            TEXT PRIMARY KEY,
                desc          TEXT NOT NULL,
                valor         REAL NOT NULL,
                data          TEXT NOT NULL,
                mes_ref       TEXT NOT NULL,
                cat_id        TEXT,
                subcat_id     TEXT,
                divisao       TEXT NOT NULL DEFAULT '[]',
                origem_regra  TEXT,
                valor_editado INTEGER NOT NULL DEFAULT 0,
                pago          INTEGER NOT NULL DEFAULT 0,
                id_grupo      TEXT,
                parcela_num   INTEGER NOT NULL DEFAULT 1,
                total_parcelas INTEGER NOT NULL DEFAULT 1
            )
        """)

        # TABELA: Orcamentos por categoria por mes
        cur.execute(
            "CREATE TABLE IF NOT EXISTS orcamentos ("
            "cat_id    TEXT NOT NULL, "
            "subcat_id TEXT NOT NULL DEFAULT '', "
            "mes       TEXT NOT NULL, "
            "valor     REAL NOT NULL DEFAULT 0, "
            "PRIMARY KEY (cat_id, subcat_id, mes))"
        )

        # TABELA: Recebimentos por pessoa (o que me devem, por mês)
        cur.execute(
            "CREATE TABLE IF NOT EXISTS pagamentos_pessoas ("
            "pessoa_id TEXT NOT NULL, "
            "mes TEXT NOT NULL, "
            "recebido INTEGER NOT NULL DEFAULT 0, "
            "PRIMARY KEY (pessoa_id, mes))"
        )

        # TABELA: Controle de pagamento por fatura de cartão (por cartão + mês)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS pagamentos_fatura (
                cartao_id TEXT NOT NULL,
                mes       TEXT NOT NULL,
                pago      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (cartao_id, mes)
            )
        """)

        # TABELA: Meses fechados (foto dos números no dia em que a pessoa "fechou" o mês; não bloqueia edição)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS meses_fechados (
                mes        TEXT PRIMARY KEY,
                fechado_em TEXT NOT NULL,
                entradas   REAL NOT NULL DEFAULT 0,
                gastos     REAL NOT NULL DEFAULT 0,
                resumo     TEXT NOT NULL DEFAULT '{}'
            )
        """)

        # TABELA: Histórico de alterações (desfazer / refazer)
        # Cada linha = UM registro que mudou (antes e depois), nunca a tabela inteira.
        cur.execute("""
            CREATE TABLE IF NOT EXISTS historico (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                grupo     INTEGER NOT NULL,
                tabela    TEXT NOT NULL,
                acao      TEXT NOT NULL,
                chave     TEXT NOT NULL,
                antes     TEXT,
                depois    TEXT,
                ts        REAL NOT NULL,
                criado_em TEXT NOT NULL,
                desfeito  INTEGER NOT NULL DEFAULT 0
            )
        """)

        # Habilita chaves estrangeiras (integridade referencial — impede lixo no banco)
        cur.execute("PRAGMA foreign_keys = ON")

        # Dados iniciais — só insere se as tabelas estiverem vazias
        pessoas_existem = cur.execute("SELECT COUNT(*) FROM pessoas").fetchone()[0]
        if not pessoas_existem:
            cur.executemany("INSERT INTO pessoas VALUES (?, ?, ?)", [
                ("p_principal", "Principal (Eu)", "principal"),
                ("p_sec_1",     "Namorado",       "secundaria"),
            ])

        con.commit()


# ============================================================
# MIGRAÇÃO AUTOMÁTICA DOS ARQUIVOS JSON ANTIGOS
# Se existirem os JSONs da versão anterior, importa os dados
# e renomeia os arquivos para não importar de novo.
# ============================================================
def migrar_jsons_antigos():
    arquivos = {
        "pessoas":    os.path.join(PASTA_MEMORIA, "pessoas.json"),
        "cartoes":    os.path.join(PASTA_MEMORIA, "cartoes.json"),
        "categorias": os.path.join(PASTA_MEMORIA, "categorias.json"),
        "entradas":   os.path.join(PASTA_MEMORIA, "entradas.json"),
        "faturas":    os.path.join(PASTA_MEMORIA, "faturas.json"),
    }

    with conectar() as con:
        cur = con.cursor()
        cur.execute("PRAGMA foreign_keys = ON")

        # --- Pessoas ---
        if os.path.exists(arquivos["pessoas"]):
            with open(arquivos["pessoas"], "r", encoding="utf-8") as f:
                pessoas = json.load(f)
            for p in pessoas:
                cur.execute("INSERT OR IGNORE INTO pessoas VALUES (?, ?, ?)",
                            (p["id"], p["nome"], p.get("tipo", "secundaria")))
            os.rename(arquivos["pessoas"], arquivos["pessoas"] + ".migrado")
            print("✅ Pessoas migradas com sucesso.")

        # --- Cartões ---
        if os.path.exists(arquivos["cartoes"]):
            with open(arquivos["cartoes"], "r", encoding="utf-8") as f:
                cartoes = json.load(f)
            for c in cartoes:
                cur.execute("INSERT OR IGNORE INTO cartoes VALUES (?, ?, ?, ?, ?)",
                            (c["id"], c["nome"], str(c["vencimento"]), c.get("cor", "#8ab4f8"), str(c.get("fechamento", "") or "")))
            os.rename(arquivos["cartoes"], arquivos["cartoes"] + ".migrado")
            print("✅ Cartões migrados com sucesso.")

        # --- Categorias e Subcategorias ---
        if os.path.exists(arquivos["categorias"]):
            with open(arquivos["categorias"], "r", encoding="utf-8") as f:
                categorias = json.load(f)
            for cat in categorias:
                cur.execute("INSERT OR IGNORE INTO categorias VALUES (?, ?)",
                            (cat["id"], cat["nome"]))
                for sub in cat.get("subcategorias", []):
                    cur.execute("INSERT OR IGNORE INTO subcategorias VALUES (?, ?, ?)",
                                (sub["id"], sub["nome"], cat["id"]))
            os.rename(arquivos["categorias"], arquivos["categorias"] + ".migrado")
            print("✅ Categorias migradas com sucesso.")

        # --- Entradas (regras fixas + transações) ---
        if os.path.exists(arquivos["entradas"]):
            with open(arquivos["entradas"], "r", encoding="utf-8") as f:
                entradas = json.load(f)
            for r in entradas.get("regras_fixas", []):
                cur.execute("INSERT OR IGNORE INTO regras_fixas VALUES (?, ?, ?, ?, ?)",
                            (r["id"], r["desc"], r["valor"], str(r["dia"]), r["inicio"]))
            for t in entradas.get("transacoes", []):
                cur.execute("INSERT OR IGNORE INTO transacoes VALUES (?, ?, ?, ?, ?)",
                            (t["id"], t["desc"], t["valor"], t["data"], t.get("origem_regra")))
            os.rename(arquivos["entradas"], arquivos["entradas"] + ".migrado")
            print("✅ Entradas migradas com sucesso.")

        # --- Faturas ---
        if os.path.exists(arquivos["faturas"]):
            with open(arquivos["faturas"], "r", encoding="utf-8") as f:
                faturas = json.load(f)
            for fat in faturas:
                cur.execute("""
                    INSERT OR IGNORE INTO faturas
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    fat["id"], fat["id_compra_pai"], fat["cartao_id"],
                    fat["desc"], fat["data_compra"], fat["mes_fatura"],
                    fat["valor_parcela"], fat["parcela_atual"], fat["total_parcelas"],
                    fat.get("cat_id"), fat.get("subcat_id"),
                    json.dumps(fat.get("divisao", []), ensure_ascii=False),
                    fat.get("fechamento_dia", ""),
                    fat.get("data_inicio", "")
                ))
            os.rename(arquivos["faturas"], arquivos["faturas"] + ".migrado")
            print("✅ Faturas migradas com sucesso.")

        con.commit()




# ============================================================
# HISTÓRICO — DESFAZER / REFAZER (Fase 1)
# Como funciona: antes e depois de cada gravação o servidor compara a
# tabela e anota SOMENTE os registros que mudaram (adicionado, alterado,
# removido). Desfazer reverte só esses registros; tudo o que foi lançado
# em outros momentos permanece intacto.
#  - Alterações feitas em até 1,5 s formam uma única ação (ex.: parcelamento
#    de 12x, criar regra fixa + os lançamentos gerados por ela).
#  - Editar o mesmo valor várias vezes seguidas vira uma única ação.
#  - Lançamentos gerados automaticamente pelas regras fixas, ao navegar
#    entre meses, não entram no histórico.
#  - Fazer qualquer ação nova apaga a lista de "refazer" (como no Word).
# ============================================================
TABELAS_POR_ROTA = {
    "/api/entradas": ["regras_fixas", "transacoes"],
    "/api/cartoes": ["cartoes"],
    "/api/pessoas": ["pessoas"],
    "/api/categorias": ["categorias", "subcategorias"],
    "/api/faturas": ["faturas"],
    "/api/importacao/confirmar": ["faturas"],
    "/api/gastos_pontuais": ["gastos_pontuais"],
    "/api/regras_gastos_fixos": ["regras_gastos_fixos"],
    "/api/pagamentos_fatura": ["pagamentos_fatura"],
    "/api/orcamentos": ["orcamentos"],
    "/api/pagamentos_pessoas": ["pagamentos_pessoas"],
    "/api/meses_fechados": ["meses_fechados"],
}
CHAVES_PRIMARIAS = {
    "regras_fixas": ["id"], "transacoes": ["id"], "cartoes": ["id"], "pessoas": ["id"],
    "categorias": ["id"], "subcategorias": ["id"], "faturas": ["id"],
    "gastos_pontuais": ["id"], "regras_gastos_fixos": ["id"],
    "pagamentos_fatura": ["cartao_id", "mes"],
    "orcamentos": ["cat_id", "subcat_id", "mes"],
    "pagamentos_pessoas": ["pessoa_id", "mes"],
    "meses_fechados": ["mes"],
}
JANELA_GRUPO = 1.5          # segundos: alterações próximas = mesma ação
JANELA_COALESCER = 10.0     # segundos: mesma edição repetida = uma ação só
MAX_ACOES_HISTORICO = 300
_lock_historico = Lock()


def _json(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def _snapshot(tabelas):
    """Lê as tabelas e devolve {tabela: {chave_json: registro}}."""
    resultado = {}
    with conectar() as con:
        for tabela in tabelas:
            registros = {}
            for linha in con.execute(f"SELECT * FROM {tabela}").fetchall():
                reg = dict(linha)
                chave = _json({c: reg[c] for c in CHAVES_PRIMARIAS[tabela]})
                registros[chave] = reg
            resultado[tabela] = registros
    return resultado


def _diferencas(antes, depois):
    """Lista o que mudou entre dois snapshots."""
    mudancas = []
    for tabela in antes:
        a, d = antes[tabela], depois.get(tabela, {})
        for chave, reg in d.items():
            if chave not in a:
                mudancas.append((tabela, "adicionou", chave, None, reg))
            elif a[chave] != reg:
                mudancas.append((tabela, "alterou", chave, a[chave], reg))
        for chave, reg in a.items():
            if chave not in d:
                mudancas.append((tabela, "removeu", chave, reg, None))
    return mudancas


def registrar_historico(antes, depois):
    mudancas = _diferencas(antes, depois)
    if not mudancas:
        return
    with _lock_historico, conectar() as con:
        agora = time.time()
        ultimo = con.execute(
            "SELECT grupo, MAX(ts) AS ts FROM historico WHERE desfeito = 0 "
            "GROUP BY grupo ORDER BY grupo DESC LIMIT 1"
        ).fetchone()
        recente = bool(ultimo) and (agora - ultimo["ts"] <= JANELA_GRUPO)

        # Lançamentos gerados sozinhos pelas regras fixas (ao trocar de mês):
        # não são ação do usuário. Só entram se acompanharem uma ação recente.
        automatico = all(
            acao == "adicionou" and tabela in ("gastos_pontuais", "transacoes")
            and (depois_reg or {}).get("origem_regra")
            for tabela, acao, _, _, depois_reg in mudancas
        )
        if automatico and not recente:
            return

        if not automatico:
            # Mesma edição repetida (ex.: digitar o orçamento): vira uma ação só
            if (len(mudancas) == 1 and mudancas[0][1] == "alterou" and ultimo
                    and agora - ultimo["ts"] <= JANELA_COALESCER):
                linhas = con.execute("SELECT * FROM historico WHERE grupo = ?", (ultimo["grupo"],)).fetchall()
                tabela, _, chave, _, reg_depois = mudancas[0]
                if (len(linhas) == 1 and linhas[0]["acao"] == "alterou"
                        and linhas[0]["tabela"] == tabela and linhas[0]["chave"] == chave):
                    if linhas[0]["antes"] == _json(reg_depois):
                        con.execute("DELETE FROM historico WHERE id = ?", (linhas[0]["id"],))
                    else:
                        con.execute("UPDATE historico SET depois = ?, ts = ? WHERE id = ?",
                                    (_json(reg_depois), agora, linhas[0]["id"]))
                    con.commit()
                    return
            # Ação nova: limpa o "refazer"
            con.execute("DELETE FROM historico WHERE desfeito = 1")

        if recente:
            grupo = ultimo["grupo"]
        else:
            grupo = (con.execute("SELECT COALESCE(MAX(grupo), 0) FROM historico").fetchone()[0]) + 1

        criado_em = datetime.now().isoformat(timespec="seconds")
        con.executemany(
            "INSERT INTO historico (grupo, tabela, acao, chave, antes, depois, ts, criado_em) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [(grupo, t, ac, ch,
              _json(a) if a is not None else None,
              _json(d) if d is not None else None,
              agora, criado_em) for t, ac, ch, a, d in mudancas]
        )
        # Mantém só as últimas ações
        limite = con.execute("SELECT COALESCE(MAX(grupo), 0) FROM historico").fetchone()[0] - MAX_ACOES_HISTORICO
        if limite > 0:
            con.execute("DELETE FROM historico WHERE grupo <= ?", (limite,))
        con.commit()


@app.before_request
def guardar_estado_antes():
    g.hist_antes = None
    if request.method == "POST" and request.path in TABELAS_POR_ROTA:
        try:
            g.hist_antes = _snapshot(TABELAS_POR_ROTA[request.path])
        except Exception:
            log.exception("Falha ao ler o estado antes de gravar")


@app.after_request
def anotar_historico(response):
    antes = getattr(g, "hist_antes", None)
    if antes is not None and response.status_code == 200:
        try:
            registrar_historico(antes, _snapshot(list(antes.keys())))
        except Exception:
            log.exception("Falha ao registrar no histórico")
    return response


# ---------- Descrições legíveis ("Excluiu 'Netflix'") ----------

def _nome_registro(con, tabela, reg):
    try:
        if tabela == "pagamentos_pessoas":
            p = con.execute("SELECT nome FROM pessoas WHERE id = ?", (reg["pessoa_id"],)).fetchone()
            return p["nome"] if p else "pessoa"
        if tabela == "pagamentos_fatura":
            c = con.execute("SELECT nome FROM cartoes WHERE id = ?", (reg["cartao_id"],)).fetchone()
            return c["nome"] if c else "cartão"
        if tabela == "orcamentos":
            c = con.execute("SELECT nome FROM categorias WHERE id = ?", (reg["cat_id"],)).fetchone()
            return c["nome"] if c else "categoria"
        if tabela == "meses_fechados":
            return "mês " + str(reg.get("mes", ""))
    except Exception:
        pass
    return reg.get("desc") or reg.get("nome") or tabela


def _descrever_grupo(con, linhas):
    verbos = {"removeu": "Excluiu", "adicionou": "Adicionou", "alterou": "Alterou"}
    partes = []
    for acao in ("removeu", "adicionou", "alterou"):
        sel = [l for l in linhas if l["acao"] == acao]
        if not sel:
            continue
        registros = [json.loads(l["depois"] if l["acao"] != "removeu" else l["antes"]) for l in sel]
        nomes = []
        for l, r in zip(sel, registros):
            n = _nome_registro(con, l["tabela"], r)
            if n not in nomes:
                nomes.append(n)

        verbo = verbos[acao]
        if acao == "alterou":
            campos = set()
            for l in sel:
                a, d = json.loads(l["antes"]), json.loads(l["depois"])
                campos |= {k for k in d if a.get(k) != d.get(k)}
            if campos <= {"pago"}:
                marcou = all(json.loads(l["depois"]).get("pago") for l in sel)
                verbo = "Marcou como pago" if marcou else "Desmarcou como pago"
            elif campos <= {"recebido"}:
                marcou = all(json.loads(l["depois"]).get("recebido") for l in sel)
                verbo = "Marcou como recebido" if marcou else "Desmarcou como recebido"
            elif all(l["tabela"] == "pagamentos_fatura" for l in sel):
                marcou = all(json.loads(l["depois"]).get("pago") for l in sel)
                verbo = "Marcou fatura como paga" if marcou else "Desmarcou fatura como paga"
            elif all(l["tabela"] == "orcamentos" for l in sel):
                verbo = "Alterou orçamento de"

        if all(l["tabela"] == "meses_fechados" for l in sel):
            verbo = {"adicionou": "Fechou o", "removeu": "Reabriu o", "alterou": "Atualizou o fechamento do"}[acao]
        if acao == "adicionou" and len(nomes) >= 3 and all(l["tabela"] == "faturas" for l in sel):
            texto = f"Importou {len(nomes)} lan\u00e7amentos de cart\u00e3o"
        elif len(nomes) == 1:
            texto = f"{verbo} \u201c{nomes[0]}\u201d"
            if len(sel) > 1:
                texto += f" ({len(sel)} itens)"
        else:
            texto = f"{verbo} {len(sel)} itens"
        partes.append(texto)
    return " e ".join(partes) if partes else "Alteração"


def _grupo_alvo(con, desfeito, mais_recente):
    ordem = "DESC" if mais_recente else "ASC"
    linha = con.execute(
        f"SELECT grupo FROM historico WHERE desfeito = ? ORDER BY grupo {ordem} LIMIT 1", (desfeito,)
    ).fetchone()
    return linha["grupo"] if linha else None


def _descricao_do_grupo(con, grupo):
    if grupo is None:
        return None
    linhas = con.execute("SELECT * FROM historico WHERE grupo = ? ORDER BY id", (grupo,)).fetchall()
    return _descrever_grupo(con, linhas)


def _gravar_registro(con, tabela, reg):
    colunas = list(reg.keys())
    con.execute(
        f"INSERT OR REPLACE INTO {tabela} ({', '.join(colunas)}) VALUES ({', '.join('?' * len(colunas))})",
        [reg[c] for c in colunas],
    )


def _apagar_registro(con, tabela, chave_json):
    chave = json.loads(chave_json)
    cond = " AND ".join(f"{c} = ?" for c in chave)
    con.execute(f"DELETE FROM {tabela} WHERE {cond}", list(chave.values()))


def _aplicar_grupo(con, grupo, desfazendo):
    linhas = con.execute("SELECT * FROM historico WHERE grupo = ? ORDER BY id", (grupo,)).fetchall()
    # Ao desfazer, reverte do mais novo para o mais antigo
    for l in (reversed(linhas) if desfazendo else linhas):
        tabela, acao = l["tabela"], l["acao"]
        voltar_a = l["antes"] if desfazendo else l["depois"]
        deve_existir = (acao != "adicionou") if desfazendo else (acao != "removeu")
        if deve_existir and voltar_a is not None:
            _gravar_registro(con, tabela, json.loads(voltar_a))
        else:
            _apagar_registro(con, tabela, l["chave"])
    con.execute("UPDATE historico SET desfeito = ? WHERE grupo = ?", (1 if desfazendo else 0, grupo))


@app.route("/api/historico", methods=["GET"])
def get_historico():
    with conectar() as con:
        g_desfazer = _grupo_alvo(con, 0, True)
        g_refazer = _grupo_alvo(con, 1, False)
        grupos = con.execute(
            "SELECT grupo, MAX(criado_em) AS criado_em, MAX(desfeito) AS desfeito "
            "FROM historico GROUP BY grupo ORDER BY grupo DESC LIMIT 30"
        ).fetchall()
        itens = [{
            "grupo": r["grupo"], "criado_em": r["criado_em"], "desfeito": bool(r["desfeito"]),
            "descricao": _descricao_do_grupo(con, r["grupo"]),
        } for r in grupos]
        return jsonify({
            "pode_desfazer": g_desfazer is not None,
            "desc_desfazer": _descricao_do_grupo(con, g_desfazer),
            "pode_refazer": g_refazer is not None,
            "desc_refazer": _descricao_do_grupo(con, g_refazer),
            "itens": itens,
        })


def _executar_historico(desfazendo):
    with _lock_historico, conectar() as con:
        grupo = _grupo_alvo(con, 0 if desfazendo else 1, desfazendo)
        if grupo is None:
            return jsonify({"ok": False, "motivo": "nada_para_desfazer" if desfazendo else "nada_para_refazer"})
        descricao = _descricao_do_grupo(con, grupo)
        _aplicar_grupo(con, grupo, desfazendo)
        con.commit()
    log.info("%s: %s", "Desfeito" if desfazendo else "Refeito", descricao)
    return jsonify({"ok": True, "descricao": descricao})


@app.route("/api/historico/desfazer", methods=["POST"])
def desfazer_ultima():
    return _executar_historico(True)


@app.route("/api/historico/refazer", methods=["POST"])
def refazer_ultima():
    return _executar_historico(False)

# ============================================================
# IMPORTAÇÃO DE FATURAS EM PDF (Fase 3)
# ============================================================
from importacao.rotas import criar_blueprint  # noqa: E402

app.register_blueprint(criar_blueprint(conectar, pasta_config, pasta_programa, log))


# ============================================================
# ANÁLISES COM IA (aba Relatórios)
# ============================================================
from assistente_ia.rotas import criar_blueprint as _criar_bp_ia  # noqa: E402

app.register_blueprint(_criar_bp_ia(pasta_config))


# ============================================================
# BOT DO TELEGRAM (lançar gastos de cartão pelo celular)
# ============================================================
from telegram_bot import dados as _tg_dados  # noqa: E402
from telegram_bot.executor import BotTelegram  # noqa: E402
from telegram_bot.rotas import criar_blueprint as _criar_bp_telegram  # noqa: E402


def _tg_lancar(payload):
    """Grava pelo mesmo caminho da importação de PDF: entra no histórico (Ctrl+Z) e na versão dos dados."""
    with app.test_client() as cliente:
        resposta = cliente.post("/api/importacao/confirmar", json=payload)
        return resposta.get_json(silent=True) or {"ok": False, "mensagem": f"erro {resposta.status_code}"}


bot_telegram = BotTelegram(
    pasta_config(),
    carregar=lambda: _tg_dados.contexto(conectar),
    lancar=_tg_lancar,
    parecidos=lambda cartao, valor, data: _tg_dados.parecidos(conectar, cartao, valor, data),
    parecidos_lista=lambda valor, desc: _tg_dados.parecidos_lista(conectar, valor, desc),
    historico=lambda desc: _tg_dados.sugerir_do_historico(conectar, desc),
    log=log,
)
app.register_blueprint(_criar_bp_telegram(bot_telegram, pasta_config))


def iniciar_bot_telegram():
    """Liga o bot se ele estiver configurado e ativado em Configs > Telegram."""
    try:
        return bot_telegram.iniciar()
    except Exception:
        log.exception("Não foi possível iniciar o bot do Telegram")
        return False


# ============================================================
# ROTA PRINCIPAL — Serve a página HTML
# ============================================================
# Aparência (tema, cor de destaque, tamanho). Fica em arquivo próprio ao lado da pasta 'memoria',
# não no banco: assim não entra no histórico de desfazer e não mexe nos seus dados.
APP_VERSAO = "2.6.2"
PALETAS_ESCURAS = ("concreto", "gofre", "grafite", "meianoite", "floresta", "vinho", "ardosia", "preto")
PALETAS_CLARAS = ("claro", "areia", "mar", "menta")
APARENCIA_PADRAO = {"paleta": "concreto", "destaque": "bordo", "densidade": "normal", "status": "paleta"}
APARENCIA_VALORES = {"paleta": PALETAS_ESCURAS + PALETAS_CLARAS,
                     "destaque": ("bordo", "gold", "steel", "moss", "violet", "coral", "teal", "rose", "orange", "lime", "custom"),
                     "densidade": ("compacta", "normal", "confortavel"),
                     "status": ("paleta", "suave", "classico", "azul", "cremebordo", "custom")}
COR_PADRAO = "#8c6bff"
# cores de "situação" (positivo / negativo / atenção) quando o jeito é personalizado
STATUS_CHAVES = {"s_ok": "#8fb39a", "s_ruim": "#cf8173", "s_atencao": "#cfae6e"}


def _cor_valida(c):
    return isinstance(c, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", c) is not None


def _cor_sobre(hex_):
    """Texto escuro ou claro, conforme a cor de fundo (para botões com a cor de destaque)."""
    r, g, b = (int(hex_[i:i + 2], 16) for i in (1, 3, 5))
    return "#14102B" if (0.299 * r + 0.587 * g + 0.114 * b) > 150 else "#FFFFFF"


def _com_tema(a):
    a["tema"] = "light" if a["paleta"] in PALETAS_CLARAS else "dark"
    a["sobre"] = _cor_sobre(a["cor"])
    return a


def ler_aparencia():
    try:
        with open(os.path.join(pasta_config(), "aparencia.json"), encoding="utf-8") as f:
            salvo = json.load(f)
    except (OSError, ValueError):
        salvo = {}
    if "paleta" not in salvo and salvo.get("tema") == "light":      # arquivo da versão anterior
        salvo["paleta"] = "claro"
    padrao_antigo = salvo.get("paleta", "grafite") in ("grafite", "gofre") and salvo.get("destaque", "gold") in ("gold", "violet")
    if salvo.get("marca") == "concreto" or (not salvo.get("marca") and padrao_antigo):
        salvo.pop("paleta", None)      # quem nunca escolheu outra aparência passa a ver o visual novo (Concreto)
        salvo.pop("destaque", None)
    a = {k: (salvo.get(k) if salvo.get(k) in v else APARENCIA_PADRAO[k]) for k, v in APARENCIA_VALORES.items()}
    a["cor"] = salvo["cor"] if _cor_valida(salvo.get("cor")) else COR_PADRAO
    for k, padrao in STATUS_CHAVES.items():
        a[k] = salvo[k] if _cor_valida(salvo.get(k)) else padrao
    return _com_tema(a)


# ---------- Aviso de versão nova (GitHub) ----------
# Preencha com "usuario/repositorio" quando o projeto estiver no GitHub. Vazio = recurso desligado.
REPO_GITHUB = "coutocdouglas/gofre"
_cache_versao = {"quando": 0, "dados": None}


def _versao_tupla(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v))[:4]) or (0,)


@app.route("/api/atualizacao")
def api_atualizacao():
    """Pergunta ao GitHub qual é a última versão publicada (só lê; nada é enviado). Falha em silêncio."""
    base = {"ativo": bool(REPO_GITHUB), "atual": APP_VERSAO, "disponivel": False}
    if not REPO_GITHUB:
        return jsonify(base)
    agora = time.time()
    if request.args.get("forcar") != "1" and _cache_versao["dados"] is not None and agora - _cache_versao["quando"] < 1800:
        return jsonify(_cache_versao["dados"])
    try:
        import urllib.request
        req = urllib.request.Request("https://api.github.com/repos/%s/releases/latest" % REPO_GITHUB,
                                     headers={"User-Agent": "Gofre", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=4) as r:
            rel = json.loads(r.read().decode("utf-8"))
        nova = str(rel.get("tag_name", "")).lstrip("vV")
        base.update({"nova": nova, "url": rel.get("html_url", ""),
                     "disponivel": _versao_tupla(nova) > _versao_tupla(APP_VERSAO)})
        for ativo in rel.get("assets", []):
            if re.fullmatch(r"Instalar_Financeiro_[\d.]+\.exe", str(ativo.get("name", ""))):
                base["instalador_url"] = ativo.get("browser_download_url", "")
                break
        base["pode_instalar"] = bool(base.get("instalador_url")) and _pode_autoatualizar()
        _cache_versao.update({"quando": agora, "dados": base})
    except Exception as e:
        base["erro"] = True
        base["erro_msg"] = str(e)[:200]       # sem internet / limite do GitHub: tenta de novo na próxima vez
    return jsonify(base)


def _pode_autoatualizar():
    """Só no programa instalado (Windows). Rodando do código, o aviso apenas abre a página do projeto."""
    return sys.platform.startswith("win") and bool(getattr(sys, "frozen", False))


def _url_instalador_valida(url):
    return bool(REPO_GITHUB) and re.fullmatch(
        r"https://github\.com/%s/releases/download/v[\d.]+/Instalar_Financeiro_[\d.]+\.exe" % re.escape(REPO_GITHUB), str(url)) is not None


_ESTADO_ATUALIZACAO = {"fase": "parado", "pct": 0, "erro": ""}


def _baixar_e_instalar(url):
    import subprocess
    import tempfile
    import urllib.request
    est = _ESTADO_ATUALIZACAO
    try:
        pasta = os.path.join(tempfile.gettempdir(), "Gofre_atualizacao")
        os.makedirs(pasta, exist_ok=True)
        destino = os.path.join(pasta, os.path.basename(url))
        est.update({"fase": "baixando", "pct": 0, "erro": ""})
        req = urllib.request.Request(url, headers={"User-Agent": "Gofre"})
        with urllib.request.urlopen(req, timeout=30) as r, open(destino, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            lido = 0
            while True:
                bloco = r.read(1 << 20)
                if not bloco:
                    break
                f.write(bloco)
                lido += len(bloco)
                if total:
                    est["pct"] = int(lido * 100 / total)
        if os.path.getsize(destino) < 1_000_000 or (total and lido != total):
            raise ValueError("download incompleto")
        est.update({"fase": "instalando", "pct": 100})
        # Instala por cima, sem janelas, e reabre o Gofre no fim. Os dados (em %APPDATA%) não são tocados.
        subprocess.Popen([destino, "/SILENT", "/CLOSEAPPLICATIONS", "/NORESTART", "/reabrir=1"], close_fds=True,
                         creationflags=0x00000008 | 0x00000200)   # DETACHED_PROCESS | NEW_PROCESS_GROUP
    except Exception as e:
        est.update({"fase": "erro", "erro": "Não foi possível atualizar agora (%s). Tente de novo mais tarde." % type(e).__name__})


@app.route("/api/atualizar_agora", methods=["POST"])
def api_atualizar_agora():
    if not _pode_autoatualizar():
        return jsonify({"status": "erro", "mensagem": "Atualização automática só no programa instalado."}), 400
    if _ESTADO_ATUALIZACAO["fase"] in ("baixando", "instalando"):
        return jsonify({"status": "sucesso"})
    d = api_atualizacao().get_json()
    if not d.get("disponivel") or not _url_instalador_valida(d.get("instalador_url")):
        return jsonify({"status": "erro", "mensagem": "Nenhuma versão nova disponível."}), 400
    Thread(target=_baixar_e_instalar, args=(d["instalador_url"],), daemon=True).start()
    return jsonify({"status": "sucesso"})


@app.route("/api/atualizar_estado")
def api_atualizar_estado():
    return jsonify(_ESTADO_ATUALIZACAO)


@app.route("/api/abrir_pagina_projeto", methods=["POST"])
def api_abrir_pagina_projeto():
    """Abre no navegador padrão a página do projeto no GitHub (só endereços do próprio repositório)."""
    url = (request.get_json(silent=True) or {}).get("url", "")
    if not REPO_GITHUB or not str(url).startswith("https://github.com/%s/" % REPO_GITHUB):
        return jsonify({"status": "erro"}), 400
    webbrowser.open(url)
    return jsonify({"status": "sucesso"})


@app.route("/api/aparencia", methods=["GET", "POST"])
def api_aparencia():
    if request.method == "POST":
        corpo = request.get_json(silent=True) or {}
        atual = ler_aparencia()
        for k, v in APARENCIA_VALORES.items():
            if corpo.get(k) in v:
                atual[k] = corpo[k]
        if _cor_valida(corpo.get("cor")):
            atual["cor"] = corpo["cor"].lower()
        for k in STATUS_CHAVES:
            if _cor_valida(corpo.get(k)):
                atual[k] = corpo[k].lower()
        atual.pop("tema", None)
        atual.pop("sobre", None)
        atual["marca"] = "concreto2"
        os.makedirs(pasta_config(), exist_ok=True)
        with open(os.path.join(pasta_config(), "aparencia.json"), "w", encoding="utf-8") as f:
            json.dump(atual, f, ensure_ascii=False)
        atual.pop("marca", None)
        return jsonify(_com_tema(atual))
    return jsonify(ler_aparencia())


@app.route("/")
def index():
    return render_template("index.html", aparencia=ler_aparencia(), versao=APP_VERSAO)


# ============================================================
# API — ENTRADAS (regras fixas + transações)
# ============================================================
@app.route("/api/entradas", methods=["GET"])
def get_entradas():
    with conectar() as con:
        regras = [dict(r) for r in con.execute("SELECT * FROM regras_fixas").fetchall()]
        transacoes = [dict(t) for t in con.execute("SELECT * FROM transacoes").fetchall()]
    return jsonify({"regras_fixas": regras, "transacoes": transacoes})


@app.route("/api/entradas", methods=["POST"])
def save_entradas():
    """
    Recebe o objeto completo {regras_fixas: [...], transacoes: [...]}
    e sincroniza o banco — exatamente como era com o JSON.
    """
    dados = request.json
    with conectar() as con:
        bloqueio = (verificar_reducao(con, "regras_fixas", len(dados.get("regras_fixas", [])))
                    or verificar_reducao(con, "transacoes", len(dados.get("transacoes", []))))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM regras_fixas")
        con.execute("DELETE FROM transacoes")
        con.executemany(
            "INSERT INTO regras_fixas VALUES (?, ?, ?, ?, ?)",
            [(r["id"], r["desc"], r["valor"], str(r["dia"]), r["inicio"])
             for r in dados.get("regras_fixas", [])]
        )
        con.executemany(
            "INSERT INTO transacoes VALUES (?, ?, ?, ?, ?)",
            [(t["id"], t["desc"], t["valor"], t["data"], t.get("origem_regra"))
             for t in dados.get("transacoes", [])]
        )
        con.commit()
    return jsonify({"status": "sucesso"})


# ============================================================
# API — CARTÕES
# ============================================================
@app.route("/api/cartoes", methods=["GET"])
def get_cartoes():
    with conectar() as con:
        cartoes = [dict(c) for c in con.execute("SELECT * FROM cartoes").fetchall()]
    return jsonify(cartoes)


@app.route("/api/cartoes", methods=["POST"])
def save_cartoes():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "cartoes", len(dados))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM cartoes")
        con.executemany(
            "INSERT INTO cartoes VALUES (?, ?, ?, ?, ?)",
            [(c["id"], c["nome"], str(c["vencimento"]), c.get("cor", "#8ab4f8"), str(c.get("fechamento", "") or ""))
             for c in dados]
        )
        con.commit()
    return jsonify({"status": "sucesso"})


# ============================================================
# API — PESSOAS
# ============================================================
@app.route("/api/pessoas", methods=["GET"])
def get_pessoas():
    with conectar() as con:
        pessoas = [dict(p) for p in con.execute("SELECT * FROM pessoas").fetchall()]
    return jsonify(pessoas)


@app.route("/api/pessoas", methods=["POST"])
def save_pessoas():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "pessoas", len(dados))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM pessoas")
        con.executemany(
            "INSERT INTO pessoas VALUES (?, ?, ?)",
            [(p["id"], p["nome"], p.get("tipo", "secundaria")) for p in dados]
        )
        con.commit()
    return jsonify({"status": "sucesso"})


# ============================================================
# API — CATEGORIAS
# O frontend ainda usa o formato {id, nome, subcategorias:[...]}
# então montamos esse formato na resposta do GET.
# ============================================================
@app.route("/api/categorias", methods=["GET"])
def get_categorias():
    with conectar() as con:
        cats = con.execute("SELECT * FROM categorias").fetchall()
        resultado = []
        for cat in cats:
            subs = con.execute(
                "SELECT * FROM subcategorias WHERE cat_id = ?", (cat["id"],)
            ).fetchall()
            resultado.append({
                "id": cat["id"],
                "nome": cat["nome"],
                "subcategorias": [{"id": s["id"], "nome": s["nome"]} for s in subs]
            })
    return jsonify(resultado)


@app.route("/api/categorias", methods=["POST"])
def save_categorias():
    dados = request.json
    with conectar() as con:
        qtd_subs = sum(len(c.get("subcategorias", [])) for c in dados)
        bloqueio = (verificar_reducao(con, "categorias", len(dados))
                    or verificar_reducao(con, "subcategorias", qtd_subs))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM subcategorias")
        con.execute("DELETE FROM categorias")
        for cat in dados:
            con.execute("INSERT INTO categorias VALUES (?, ?)", (cat["id"], cat["nome"]))
            for sub in cat.get("subcategorias", []):
                con.execute("INSERT INTO subcategorias VALUES (?, ?, ?)",
                            (sub["id"], sub["nome"], cat["id"]))
        con.commit()
    return jsonify({"status": "sucesso"})


# ============================================================
# API — FATURAS
# ============================================================
@app.route("/api/faturas", methods=["GET"])
def get_faturas():
    with conectar() as con:
        rows = con.execute("SELECT * FROM faturas").fetchall()
        faturas = []
        for r in rows:
            fat = dict(r)
            fat["divisao"] = json.loads(fat["divisao"])  # Converte texto → lista
            fat["fixo"] = bool(fat.get("fixo"))          # dívida fixa paga pelo cartão (aparece em Gastos Fixos)
            faturas.append(fat)
    return jsonify(faturas)


@app.route("/api/faturas", methods=["POST"])
def save_faturas():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "faturas", len(dados))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM faturas")
        con.executemany(
            "INSERT INTO faturas (id, id_compra_pai, cartao_id, desc, data_compra, mes_fatura, valor_parcela, "
            "parcela_atual, total_parcelas, cat_id, subcat_id, divisao, fechamento_dia, data_inicio, fixo) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(
                f["id"], f["id_compra_pai"], f["cartao_id"],
                f["desc"], f["data_compra"], f["mes_fatura"],
                f["valor_parcela"], f["parcela_atual"], f["total_parcelas"],
                f.get("cat_id"), f.get("subcat_id"),
                json.dumps(f.get("divisao", []), ensure_ascii=False),
                f.get("fechamento_dia", ""),
                f.get("data_inicio", ""),
                1 if f.get("fixo") else 0
            ) for f in dados]
        )
        con.commit()
    return jsonify({"status": "sucesso"})


# ============================================================
# API — GASTOS PONTUAIS
# Inclui tanto os avulsos quanto os gerados por regras fixas de gastos
# ============================================================
@app.route("/api/gastos_pontuais", methods=["GET"])
def get_gastos_pontuais():
    with conectar() as con:
        rows = con.execute("SELECT * FROM gastos_pontuais").fetchall()
        resultado = []
        for r in rows:
            g = dict(r)
            g["divisao"] = json.loads(g["divisao"])
            g["valor_editado"] = bool(g["valor_editado"])
            g["pago"]          = bool(g["pago"])
            resultado.append(g)
    return jsonify(resultado)


@app.route("/api/gastos_pontuais", methods=["POST"])
def save_gastos_pontuais():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "gastos_pontuais", len(dados))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM gastos_pontuais")
        con.executemany(
            "INSERT INTO gastos_pontuais VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(
                g["id"], g["desc"], g["valor"], g["data"], g["mes_ref"],
                g.get("cat_id"), g.get("subcat_id"),
                json.dumps(g.get("divisao", []), ensure_ascii=False),
                g.get("origem_regra"),
                1 if g.get("valor_editado") else 0,
                1 if g.get("pago") else 0,
                g.get("id_grupo"),
                g.get("parcela_num", 1),
                g.get("total_parcelas", 1)
            ) for g in dados]
        )
        con.commit()
    return jsonify({"status": "sucesso"})


# ============================================================
# API — REGRAS DE GASTOS FIXOS
# ============================================================
@app.route("/api/regras_gastos_fixos", methods=["GET"])
def get_regras_gastos_fixos():
    with conectar() as con:
        rows = con.execute("SELECT * FROM regras_gastos_fixos").fetchall()
        resultado = []
        for r in rows:
            reg = dict(r)
            reg["divisao"] = json.loads(reg["divisao"])
            try:
                reg["meses_pulados"] = json.loads(reg.get("meses_pulados") or "[]")
            except ValueError:
                reg["meses_pulados"] = []
            resultado.append(reg)
    return jsonify(resultado)


@app.route("/api/regras_gastos_fixos", methods=["POST"])
def save_regras_gastos_fixos():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "regras_gastos_fixos", len(dados))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM regras_gastos_fixos")
        con.executemany(
            "INSERT INTO regras_gastos_fixos (id, desc, valor, dia, cat_id, subcat_id, inicio, divisao, meses_pulados) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(
                r["id"], r["desc"], r["valor"], r["dia"],
                r.get("cat_id"), r.get("subcat_id"), r["inicio"],
                json.dumps(r.get("divisao", []), ensure_ascii=False),
                json.dumps(sorted(set(r.get("meses_pulados") or [])), ensure_ascii=False)
            ) for r in dados]
        )
        con.commit()
    return jsonify({"status": "sucesso"})


# ============================================================
# API — PAGAMENTOS DE FATURA (controle de pagamento por cartão/mês)
# ============================================================
@app.route("/api/pagamentos_fatura", methods=["GET"])
def get_pagamentos_fatura():
    with conectar() as con:
        rows = con.execute("SELECT * FROM pagamentos_fatura").fetchall()
        return jsonify([dict(r) for r in rows])

@app.route("/api/pagamentos_fatura", methods=["POST"])
def save_pagamentos_fatura():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "pagamentos_fatura", len(dados or []))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM pagamentos_fatura")
        if dados:
            con.executemany(
                "INSERT INTO pagamentos_fatura VALUES (?, ?, ?)",
                [(d["cartao_id"], d["mes"], 1 if d.get("pago") else 0) for d in dados]
            )
        con.commit()
    return jsonify({"status": "sucesso"})


# ============================================================
# API — ORCAMENTOS
# ============================================================
@app.route("/api/orcamentos", methods=["GET"])
def get_orcamentos():
    with conectar() as con:
        rows = con.execute("SELECT * FROM orcamentos").fetchall()
        return jsonify([dict(r) for r in rows])

@app.route("/api/orcamentos", methods=["POST"])
def save_orcamentos():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "orcamentos", len(dados or []))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM orcamentos")
        if dados:
            con.executemany("INSERT INTO orcamentos VALUES (?, ?, ?, ?)",
                [(d["cat_id"], d.get("subcat_id", ""), d["mes"], d["valor"]) for d in dados])
        con.commit()
    return jsonify({"status": "sucesso"})


# API — PAGAMENTOS DE PESSOAS
# ============================================================
@app.route("/api/pagamentos_pessoas", methods=["GET"])
def get_pagamentos_pessoas():
    with conectar() as con:
        rows = con.execute("SELECT * FROM pagamentos_pessoas").fetchall()
        return jsonify([dict(r) for r in rows])

@app.route("/api/pagamentos_pessoas", methods=["POST"])
def save_pagamentos_pessoas():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "pagamentos_pessoas", len(dados or []))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM pagamentos_pessoas")
        if dados:
            con.executemany("INSERT INTO pagamentos_pessoas VALUES (?, ?, ?)",
                [(d["pessoa_id"], d["mes"], 1 if d.get("recebido") else 0) for d in dados])
        con.commit()
    return jsonify({"status": "sucesso"})


# API — MESES FECHADOS
# ============================================================
@app.route("/api/meses_fechados", methods=["GET"])
def get_meses_fechados():
    with conectar() as con:
        rows = con.execute("SELECT * FROM meses_fechados ORDER BY mes").fetchall()
        saida = []
        for r in rows:
            d = dict(r)
            try:
                d["resumo"] = json.loads(d["resumo"] or "{}")
            except ValueError:
                d["resumo"] = {}
            saida.append(d)
        return jsonify(saida)

@app.route("/api/meses_fechados", methods=["POST"])
def save_meses_fechados():
    dados = request.json
    with conectar() as con:
        bloqueio = verificar_reducao(con, "meses_fechados", len(dados or []))
        if bloqueio:
            return bloqueio
        con.execute("DELETE FROM meses_fechados")
        if dados:
            con.executemany("INSERT INTO meses_fechados VALUES (?, ?, ?, ?, ?)",
                [(d["mes"], d.get("fechado_em", ""), float(d.get("entradas", 0)), float(d.get("gastos", 0)),
                  json.dumps(d.get("resumo", {}), ensure_ascii=False)) for d in dados])
        con.commit()
    return jsonify({"status": "sucesso"})


# INICIALIZAÇÃO DO SERVIDOR
# ============================================================
def abrir_navegador():
    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        webbrowser.open("http://127.0.0.1:5000")  # open() reutiliza aba existente

def migrar_colunas_novas():
    """Adiciona colunas novas em tabelas existentes sem apagar dados."""
    with conectar() as con:
        cur = con.cursor()
        # Adiciona coluna 'fechamento_dia' em faturas se ainda não existir
        # Adiciona coluna 'fechamento' em cartoes se ainda não existir
        colunas_cartao = [row[1] for row in cur.execute("PRAGMA table_info(cartoes)").fetchall()]
        if 'fechamento' not in colunas_cartao:
            cur.execute("ALTER TABLE cartoes ADD COLUMN fechamento TEXT NOT NULL DEFAULT ''")
            print("✅ Coluna 'fechamento' adicionada em cartoes.")

        # Meses em que o usuário excluiu "só este mês" um gasto fixo (a regra não recria nesses meses)
        colunas_rgf = [row[1] for row in cur.execute("PRAGMA table_info(regras_gastos_fixos)").fetchall()]
        if 'meses_pulados' not in colunas_rgf:
            cur.execute("ALTER TABLE regras_gastos_fixos ADD COLUMN meses_pulados TEXT NOT NULL DEFAULT '[]'")
            print("OK coluna 'meses_pulados' adicionada em regras_gastos_fixos.")

        colunas_fat = [row[1] for row in cur.execute("PRAGMA table_info(faturas)").fetchall()]
        if 'fechamento_dia' not in colunas_fat:
            cur.execute("ALTER TABLE faturas ADD COLUMN fechamento_dia TEXT NOT NULL DEFAULT ''")
            print("✅ Coluna 'fechamento_dia' adicionada em faturas.")
        if 'data_inicio' not in colunas_fat:
            cur.execute("ALTER TABLE faturas ADD COLUMN data_inicio TEXT NOT NULL DEFAULT ''")
            print("✅ Coluna 'data_inicio' adicionada em faturas.")
        if 'fixo' not in colunas_fat:
            cur.execute("ALTER TABLE faturas ADD COLUMN fixo INTEGER NOT NULL DEFAULT 0")
            print("OK coluna 'fixo' adicionada em faturas.")
        colunas_regras = [row[1] for row in cur.execute("PRAGMA table_info(regras_importacao)").fetchall()]
        if colunas_regras and 'fixo' not in colunas_regras:
            cur.execute("ALTER TABLE regras_importacao ADD COLUMN fixo INTEGER NOT NULL DEFAULT 0")
        # Coluna pago em gastos_pontuais
        colunas_gp = [row[1] for row in cur.execute("PRAGMA table_info(gastos_pontuais)").fetchall()]
        if 'pago' not in colunas_gp:
            cur.execute("ALTER TABLE gastos_pontuais ADD COLUMN pago INTEGER NOT NULL DEFAULT 0")
            print("✅ Coluna 'pago' adicionada em gastos_pontuais.")
        if "id_grupo" not in colunas_gp:
            cur.execute("ALTER TABLE gastos_pontuais ADD COLUMN id_grupo TEXT")
            cur.execute("ALTER TABLE gastos_pontuais ADD COLUMN parcela_num INTEGER NOT NULL DEFAULT 1")
            cur.execute("ALTER TABLE gastos_pontuais ADD COLUMN total_parcelas INTEGER NOT NULL DEFAULT 1")
            print("OK parcelamento adicionado em gastos_pontuais.")
        con.commit()

def backup_de_abertura():
    """Backup ao abrir o programa (ignora se já houve um há menos de 1 minuto,
    pois o modo debug do Flask executa este arquivo duas vezes)."""
    try:
        idade = _idade_ultimo_backup()
        if idade is None or idade > 60:
            fazer_backup("abertura")
    except Exception:
        log.exception("Falha no backup de abertura")


def preparar_banco():
    """Rotina de abertura, usada tanto pelo .bat quanto pelo programa de Windows."""
    backup_de_abertura()   # 0. Backup ANTES de qualquer migração
    inicializar_db()       # 1. Cria as tabelas (se não existirem)
    migrar_colunas_novas() # 2. Adiciona colunas novas em tabelas existentes
    migrar_jsons_antigos() # 3. Importa dados dos JSONs antigos (se existirem)


if __name__ == "__main__":
    preparar_banco()
    iniciar_bot_telegram()
    Timer(1.2, abrir_navegador).start()  # abre uma única vez após o servidor subir
    app.run(debug=True, port=5000)
