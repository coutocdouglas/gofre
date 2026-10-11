import copy
import json
import os

import pytest

from fixtures_faturas import INTER_PAGINAS, XP_PAGINAS
from importacao import senhas
from importacao.emissores import base, inter, xp
from importacao.emissores.base import ErroLeitura
from importacao.leitor import (PdfInvalido, SenhaIncorreta, SenhaNecessaria, extrair_paginas,
                               ler_fatura)
from pdf_ficticio import gerar_pdf


# ---------------- Funções básicas ----------------

def test_valor_br():
    assert base.valor_br("3.449,54") == 3449.54
    assert base.valor_br("-4.243,92") == -4243.92
    assert base.valor_br("R$ 2,80") == 2.8
    assert base.valor_br("1,00") == 1.0


def test_datas():
    assert base.data_iso_dmy("03/12/25") == "2025-12-03"
    assert base.data_iso_dmy("10/10/2026") == "2026-10-10"
    assert base.data_iso_extenso("12", "set", "2026") == "2026-09-12"
    assert base.data_iso_extenso("09", "dez", "2025") == "2025-12-09"


@pytest.mark.parametrize("bruto,esperado", [
    ("MP *SAMSUNG - Parcela 10/15", ("MP *SAMSUNG", 10, 15)),
    ("ZP *OLX VENDEDOR13623 - Parcela 1/10", ("ZP *OLX VENDEDOR13623", 1, 10)),
    ("MLP*KaBuM-Magazine Lui (Parcela 05 de 10)", ("MLP*KaBuM-Magazine Lui", 5, 10)),
    ("AMAZON BR (Parcela 02 de 09)", ("AMAZON BR", 2, 9)),
    ("SUPERMERCADOS BH", ("SUPERMERCADOS BH", None, None)),
    ("DL *UBERRIDES", ("DL *UBERRIDES", None, None)),
])
def test_extrair_parcela(bruto, esperado):
    assert base.extrair_parcela(bruto) == esperado


@pytest.mark.parametrize("desc,valor,tipo", [
    ("Pagamento de fatura", -4243.92, "pagamento"),
    ("PAGAMENTO ON LINE", -2539.23, "pagamento"),
    ("Estorno compra", -50.0, "estorno"),
    ("IOF Transacoes Exterior", 2.8, "encargo"),
    ("JUROS PIX CREDITO", 10.28, "encargo"),
    ("IOF", 0.68, "encargo"),
    ("IOFERTAS LOJA", 10.0, "compra"),
    ("SUPERMERCADOS BH", 337.58, "compra"),
])
def test_classificar(desc, valor, tipo):
    assert base.classificar(desc, valor) == tipo


# ---------------- Fatura XP ----------------

@pytest.fixture(scope="module")
def fatura_xp():
    return xp.ler(XP_PAGINAS)


def test_xp_resumo(fatura_xp):
    f = fatura_xp
    assert f["emissor"] == "xp" and f["vencimento"] == "2026-10-10" and f["mes_fatura"] == "2026-10"
    assert f["fechamento"] == "2026-10-01" and f["total_fatura"] == 3449.54


def test_xp_secoes_e_quantidade_de_linhas(fatura_xp):
    s = fatura_xp["secoes"]
    assert [x["final"] for x in s] == ["9258", "4350"]
    assert [len(x["linhas"]) for x in s] == [58, 3]
    assert [x["subtotal"] for x in s] == [3041.97, 407.57]


def test_xp_confere_com_o_total_sem_somar_o_pagamento(fatura_xp):
    c = fatura_xp["conferencia"]
    assert c["ok"] and c["soma_linhas"] == 3449.54 and c["diferenca"] == 0.0
    pagamentos = [l for s in fatura_xp["secoes"] for l in s["linhas"] if l["tipo"] == "pagamento"]
    assert len(pagamentos) == 1 and pagamentos[0]["valor"] == -4243.92


def test_xp_parcelas(fatura_xp):
    linhas = {l["descricao"]: l for s in fatura_xp["secoes"] for l in s["linhas"]}
    sam = linhas["MP *SAMSUNG"]
    assert (sam["parcela_atual"], sam["total_parcelas"], sam["valor"], sam["data"]) == (10, 15, 61.46, "2025-12-03")
    assert linhas["ZP *OLX VENDEDOR13623"]["parcela_atual"] == 1
    assert linhas["046 - MG BH BOULEVARD"]["total_parcelas"] == 2     # descrição com " - " no meio


def test_xp_compra_em_dolar_e_iof(fatura_xp):
    linhas = {l["descricao"]: l for s in fatura_xp["secoes"] for l in s["linhas"]}
    assert linhas["MAGNIFIC"]["valor"] == 80.0 and linhas["MAGNIFIC"]["valor_usd"] == 15.73
    iof = linhas["IOF Transacoes Exterior"]
    assert iof["valor"] == 2.8 and iof["tipo"] == "encargo" and iof["valor_usd"] is None


def test_xp_ignora_ruido_de_quebra_de_pagina(fatura_xp):
    descs = [l["descricao_original"] for s in fatura_xp["secoes"] for l in s["linhas"]]
    assert not any("Titular" in d or "Subtotal" in d or "0800" in d for d in descs)


def test_xp_sequencia_unica(fatura_xp):
    seqs = [l["seq"] for s in fatura_xp["secoes"] for l in s["linhas"]]
    assert seqs == list(range(1, len(seqs) + 1))
    assert all(l["secao"] == i for i, s in enumerate(fatura_xp["secoes"]) for l in s["linhas"])


# ---------------- Fatura Inter ----------------

@pytest.fixture(scope="module")
def fatura_inter():
    return inter.ler(INTER_PAGINAS)


def test_inter_resumo(fatura_inter):
    f = fatura_inter
    assert f["emissor"] == "inter" and f["vencimento"] == "2026-10-12" and f["mes_fatura"] == "2026-10"
    assert f["total_fatura"] == 1863.43


def test_inter_secoes(fatura_inter):
    s = fatura_inter["secoes"]
    assert [x["final"] for x in s] == ["8616", "7938", "5592", "7991"]
    assert [len(x["linhas"]) for x in s] == [4, 1, 1, 10]
    assert [x["subtotal"] for x in s] == [142.54, 141.49, 259.9, 1319.5]


def test_inter_confere_e_credito_fica_negativo(fatura_inter):
    assert fatura_inter["conferencia"]["ok"]
    pag = [l for s in fatura_inter["secoes"] for l in s["linhas"] if l["tipo"] == "pagamento"]
    assert len(pag) == 1 and pag[0]["valor"] == -2539.23 and pag[0]["data"] == "2026-09-12"


def test_inter_parcelas_e_encargos(fatura_inter):
    linhas = [l for s in fatura_inter["secoes"] for l in s["linhas"]]
    kabum = next(l for l in linhas if "KaBuM" in l["descricao"])
    assert (kabum["parcela_atual"], kabum["total_parcelas"], kabum["valor"]) == (5, 10, 141.49)
    assert {l["descricao"] for l in linhas if l["tipo"] == "encargo"} == {"JUROS PIX CREDITO", "IOF"}
    assert sum(1 for l in linhas if l["descricao"] == "BR1*BUSER") == 2     # duas linhas iguais de descrição


def test_inter_nao_importa_a_proxima_fatura(fatura_inter):
    descs = [l["descricao"] for s in fatura_inter["secoes"] for l in s["linhas"]]
    assert not any("SHOPPING INTER" in d and "10" in d for d in descs if False)
    todas = [l for s in fatura_inter["secoes"] for l in s["linhas"]]
    shopping = [l for l in todas if "SHOPPING INTER" in l["descricao"]]
    assert len(shopping) == 1 and shopping[0]["parcela_atual"] == 9    # só a 9/10; a 10/10 é da próxima fatura
    assert len(todas) == 16


# ---------------- Conferência detecta problemas ----------------

def test_conferencia_acusa_diferenca():
    f = copy.deepcopy(xp.ler(XP_PAGINAS))
    f["secoes"][0]["linhas"][0]["valor"] += 10
    from importacao.emissores.base import conferir
    c = conferir(f)
    assert c["ok"] is False and c["diferenca"] == 10.0
    assert c["secoes"][0]["ok"] is False and c["secoes"][1]["ok"] is True


def test_texto_desconhecido_gera_erro_claro():
    with pytest.raises(ErroLeitura):
        xp.ler(["nada de fatura aqui"])
    with pytest.raises(ErroLeitura):
        inter.ler(["CARTÃO 1234****5678\nTotal CARTÃO 1234****5678 R$ 1,00"])


# ---------------- PDF de verdade ----------------

def test_le_pdf_xp_sem_senha():
    f, senha, h = ler_fatura(gerar_pdf(XP_PAGINAS))
    assert senha is None and f["emissor"] == "xp" and f["conferencia"]["ok"] and len(h) == 64
    assert sum(len(s["linhas"]) for s in f["secoes"]) == 61


def test_le_pdf_inter_sem_senha():
    f, _, _ = ler_fatura(gerar_pdf(INTER_PAGINAS))
    assert f["emissor"] == "inter" and f["conferencia"]["ok"]


def test_mesmo_arquivo_mesmo_hash():
    d = gerar_pdf(XP_PAGINAS)
    assert ler_fatura(d)[2] == ler_fatura(d)[2]


@pytest.mark.parametrize("algoritmo", ["RC4-128", "AES-128", "AES-256"])
def test_senha_em_todos_os_tipos_de_criptografia(algoritmo):
    dados = gerar_pdf(INTER_PAGINAS, senha="123456", algoritmo=algoritmo)
    with pytest.raises(SenhaNecessaria):
        ler_fatura(dados)
    f, usada, _ = ler_fatura(dados, senhas_salvas=["000000", "123456"])      # tenta em ordem
    assert usada == "123456" and f["total_fatura"] == 1863.43
    f, usada, _ = ler_fatura(dados, senha_digitada="123456")
    assert usada == "123456"


def test_senha_errada_e_diferenciada_de_senha_necessaria():
    dados = gerar_pdf(XP_PAGINAS, senha="123456")
    with pytest.raises(SenhaNecessaria):
        ler_fatura(dados, senhas_salvas=["111111"])
    with pytest.raises(SenhaIncorreta):
        ler_fatura(dados, senha_digitada="errada", senhas_salvas=["111111"])


def test_pdf_invalido():
    for lixo in (b"", b"isto nao e pdf", b"%PDF-1.4 quebrado"):
        with pytest.raises(PdfInvalido):
            extrair_paginas(lixo)


def test_pdf_sem_texto_ou_de_outro_emissor():
    with pytest.raises(ErroLeitura):
        ler_fatura(gerar_pdf(["   "]))
    with pytest.raises(ErroLeitura) as e:
        ler_fatura(gerar_pdf(["Extrato do Banco Qualquer\n01/01/26 COMPRA 10,00"]))
    assert "XP e Inter" in str(e.value)


# ---------------- Senhas guardadas fora do código ----------------

def test_senhas_vazio(tmp_path):
    assert senhas.carregar(str(tmp_path / "cfg")) == []


def test_senhas_adicionar_ordem_e_sem_repeticao(tmp_path):
    cfg = str(tmp_path)
    assert senhas.adicionar(cfg, "aaa") == ["aaa"]
    assert senhas.adicionar(cfg, "bbb") == ["bbb", "aaa"]
    assert senhas.adicionar(cfg, "aaa") == ["aaa", "bbb"]
    assert senhas.adicionar(cfg, "  ") == ["aaa", "bbb"]
    assert senhas.carregar(cfg) == ["aaa", "bbb"]


def test_senhas_importa_do_projeto_na_primeira_vez_sem_mover(tmp_path):
    projeto = tmp_path / "projeto"; projeto.mkdir()
    (projeto / "senhas_pdf.json").write_text(json.dumps({"senhas": ["111", 222]}), encoding="utf-8")
    cfg = tmp_path / "cfg"
    assert senhas.carregar(str(cfg), [str(projeto)]) == ["111", "222"]
    assert (cfg / "senhas_pdf.json").exists() and (projeto / "senhas_pdf.json").exists()
    (projeto / "senhas_pdf.json").unlink()
    assert senhas.carregar(str(cfg), [str(projeto)]) == ["111", "222"]        # já está na config


def test_senhas_arquivo_corrompido_nao_quebra(tmp_path):
    (tmp_path / "senhas_pdf.json").write_text("{lixo", encoding="utf-8")
    assert senhas.carregar(str(tmp_path)) == []
    assert senhas.adicionar(str(tmp_path), "x") == ["x"]


def test_senhas_limpar(tmp_path):
    senhas.adicionar(str(tmp_path), "x")
    senhas.limpar(str(tmp_path))
    senhas.limpar(str(tmp_path))     # repetir não dá erro
    assert senhas.carregar(str(tmp_path)) == []
