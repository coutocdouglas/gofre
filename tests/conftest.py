import os
import sys
import importlib
import pytest

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAIZ)


@pytest.fixture()
def appmod(tmp_path, monkeypatch):
    """Carrega o app apontando para uma pasta de dados temporária (nunca toca no banco real)."""
    monkeypatch.setenv("FINANCEIRO_DATA_DIR", str(tmp_path / "dados"))
    monkeypatch.setenv("FINANCEIRO_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("FINANCEIRO_PASTA_PROGRAMA", str(tmp_path / "programa"))
    if "app" in sys.modules:
        del sys.modules["app"]
    mod = importlib.import_module("app")
    mod.inicializar_db()
    mod.migrar_colunas_novas()
    return mod


@pytest.fixture()
def client(appmod):
    appmod.app.config["TESTING"] = True
    return appmod.app.test_client()


def gasto(i, mes="2026-10"):
    return {
        "id": f"gp_{i}", "desc": f"Gasto {i}", "valor": 10.0 + i, "data": f"{mes}-05",
        "mes_ref": mes, "cat_id": None, "subcat_id": None,
        "divisao": [{"pessoa_id": "p_principal", "valor": 10.0 + i}],
        "origem_regra": None, "valor_editado": False, "pago": False,
        "id_grupo": None, "parcela_num": 1, "total_parcelas": 1,
    }
