"""A conversa: transforma o que você manda no Telegram em perguntas com botões e, no fim, num lançamento.

Esta parte não fala com o Telegram nem com o banco (isso é feito por quem a usa), por isso é fácil de testar.
Cada resposta é um dict: {"modo": "novo" | "editar", "texto": ..., "botoes": [[(rótulo, dado), ...], ...]}.
"""
import html
from datetime import date, timedelta

from importacao.sugestoes import aplicar_regra

from . import dados as dados_mod
from .leitura import sem_acento
from .texto import dia_mes, entender, entender_parcial, mes_rotulo, moeda

AJUDA = (
    "Mande o gasto em uma mensagem. Exemplos:\n"
    "• <code>45,90 uber</code>\n"
    "• <code>mercado 120 ontem</code>\n"
    "• <code>notebook 3000 em 10x</code> (o valor é o total)\n"
    "• <code>academia 129,90 05/10</code>\n\n"
    "📷 Também aceito um <b>print</b> (notificação de compra ou lista de compras) do XP ou do Inter: eu leio o valor e o nome. "
    "A data é sempre a de hoje (troque pelo botão 📅 ou escreva na legenda, ex.: <code>ontem</code> ou <code>05/10</code>) "
    "e a categoria é sempre você quem escolhe.\n\n"
    "Depois é só tocar nos botões para escolher cartão, categoria e de quem é. "
    "Se algo der errado, aperte Ctrl+Z no programa.\n"
    "/cancelar desiste do lançamento que está aberto."
)


def _e(txt):
    return html.escape(str(txt), quote=False)


class Conversa:
    """lancar(payload) -> dict {"ok": bool, "mensagem": str, ...}   (grava de verdade)
    carregar() -> contexto (cartoes, categorias, pessoas, regras)
    parecidos(cartao_id, valor_parcela, data_iso) -> lista de lançamentos parecidos."""

    def __init__(self, carregar, lancar, parecidos, hoje=date.today, parecidos_lista=None, finais=None, historico=None):
        self._carregar, self._lancar, self._parecidos, self._hoje_base = carregar, lancar, parecidos, hoje
        self._dia = None                         # dia em que a mensagem em tratamento foi ENVIADA (mensagens antigas: o dia delas)
        self._fila = {}                          # chat -> mensagens antigas esperando a vez (ver texto/imagem com fila=True)
        self._historico = historico or (lambda desc: None)
        self._parecidos_lista = parecidos_lista or (lambda valor, desc: [])
        self._finais = finais                    # objeto com .get(final) -> id do cartão e .set(final, id) (opcional)
        self.estados = {}
        self._contador = 0

    def _hoje(self):
        """'Hoje' para esta conversa: o dia em que a pessoa mandou a mensagem (importa para as que ficaram na fila)."""
        return self._dia or self._hoje_base()

    @staticmethod
    def _quando_enviada(dia, base):
        return f"(enviada em {dia_mes(dia.isoformat())}) " if dia and dia != base else ""

    # ------------------------------------------------------------ entrada
    def texto(self, chat, txt, dia=None, fila=False):
        t = (txt or "").strip()
        if t.lower() in ("/start", "/ajuda", "/help", "ajuda"):
            return [self._msg("👋 Oi! Eu lanço gastos no seu cartão.\n\n" + AJUDA)]
        if t.lower() in ("/cancelar", "cancelar"):
            tinha = self.estados.pop(chat, None)
            if not tinha:
                self._fila.pop(chat, None)
            seguinte = self._proxima_da_fila(chat)
            return [self._msg("Ok, cancelei." + ("" if seguinte else " Pode mandar outro gasto quando quiser."))] + seguinte
        aberto = self.estados.get(chat)
        if fila and aberto:                                           # mensagem antiga e já tem um lançamento aberto: espera a vez
            self._fila.setdefault(chat, []).append(("texto", t, dia))
            return []
        self._dia = (aberto or {}).get("dia") if aberto and aberto.get("espera") else dia
        if aberto and aberto.get("espera"):
            resposta = self._texto_esperado(chat, aberto, t)
            if resposta is not None:
                return resposta
            self._dia = dia
        parsed, erro = entender(t, self._hoje())
        if erro:
            return [self._msg("🤔 " + erro + "\n\n" + AJUDA)]
        ctx = self._carregar()
        if not ctx["cartoes"] or not ctx["categorias"] or not ctx["pessoas"]:
            return [self._msg("Antes preciso que o programa tenha pelo menos um cartão, uma categoria e uma pessoa cadastrados.")]
        self._contador += 1
        e = {"n": self._contador, "ctx": ctx, "rasc": self._rascunho(parsed, ctx), "passo": "resumo", "dia": self._dia}
        e["rasc"]["prefixo"] = self._quando_enviada(self._dia, self._hoje_base())
        self.estados[chat] = e
        return [self._seguir(e, "novo")]

    def _proxima_da_fila(self, chat):
        """Terminou um lançamento: abre o próximo das mensagens que chegaram enquanto o programa estava desligado."""
        saida = []
        while self._fila.get(chat) and chat not in self.estados:
            item = self._fila[chat].pop(0)
            if item[0] == "texto":
                saida += self.texto(chat, item[1], dia=item[2])
            else:
                saida += self.imagem(chat, item[1], item[2], dia=item[3])
        if not self._fila.get(chat):
            self._fila.pop(chat, None)
        return saida

    def botao(self, chat, dado):
        resposta = self._botao(chat, dado)
        if chat not in self.estados and self._fila.get(chat):
            resposta = resposta + self._proxima_da_fila(chat)
        return resposta

    def _botao(self, chat, dado):
        e = self.estados.get(chat)
        try:
            n, acao, arg = dado.split("|", 2)
        except ValueError:
            return [self._msg("Não entendi esse botão.", "editar")]
        if e is None or str(e["n"]) != n:
            return [{"modo": "editar", "texto": "Esse lançamento já foi encerrado. Mande o gasto de novo para começar outro.", "botoes": []}]
        e["espera"] = None
        self._dia = e.get("dia")
        if "lista" in e:
            return self._botao_lista(chat, e, acao, arg)
        r, ctx = e["rasc"], e["ctx"]

        if acao == "cancelar":
            self.estados.pop(chat, None)
            if e.get("lote"):
                e["lote"]["pulados"] += 1
                return [{"modo": "editar", "texto": "⏭️ Pulei esse.", "botoes": []}] + self._proximo(chat, e)
            return [{"modo": "editar", "texto": "❌ Cancelado.", "botoes": []}]
        if acao == "lancar":
            res = self._gravar(chat, e)
            if self.estados.get(chat) is not e and e.get("final") and self._finais:     # gravou: guarda de qual cartão é esse "final 7991"
                self._finais.set(e["final"], ctx["cartoes"][r["cartao_i"]]["id"])
            if self.estados.get(chat) is e or not e.get("lote"):        # não gravou (ou não é um lote): segue como antes
                return [res]
            e["lote"]["ok"] += 1
            return [res] + self._proximo(chat, e)
        if acao == "data":
            if arg == "abrir":
                e["passo"], e["espera"] = "data", "data"
                return [self._tela(e, "editar")]
            if arg != "voltar":
                self._aplicar_data(e, (self._hoje_base() - timedelta(days=int(arg))).isoformat())
            return [self._seguir(e, "editar")]
        if acao == "corrigir":
            e["passo"], e["espera"] = "corrigir", "corrigir"
            return [self._tela(e, "editar")]
        if acao == "editar":
            e["passo"] = {"cartao": "cartao", "cat": "cat", "pes": "pes"}.get(arg, "resumo")
            return [self._tela(e, "editar")]
        if acao == "cartao":
            r["cartao_i"] = int(arg)
            if e.get("lote"):
                e["lote"]["cartao_i"] = int(arg)              # o resto do mesmo print costuma ser do mesmo cartão
        elif acao == "cat":
            r["cat_i"] = int(arg)
            r["sub_i"] = None
            r["sub_perguntada"] = False
        elif acao == "sub":
            r["sub_i"] = None if arg == "-" else int(arg)
            r["sub_perguntada"] = True
        elif acao == "pes":
            if arg == "ok":
                if not r["pessoas"]:
                    return [self._tela(e, "editar", aviso="Marque pelo menos uma pessoa.")]
                e["passo"] = "resumo"
                return [self._seguir(e, "editar")]
            i = int(arg)
            r["pessoas"] = [x for x in r["pessoas"] if x != i] if i in r["pessoas"] else sorted(r["pessoas"] + [i])
            r["div_pct"] = None            # mexeu nas pessoas: volta a dividir por igual
            e["passo"] = "pes"
            return [self._tela(e, "editar")]
        elif acao == "fixo":
            r["fixo"] = not r["fixo"]
            e["passo"] = "resumo"
            return [self._tela(e, "editar")]
        elif acao == "lembrar":
            r["lembrar"] = not r["lembrar"]
            e["passo"] = "resumo"
            return [self._tela(e, "editar")]
        e["passo"] = "resumo"
        return [self._seguir(e, "editar")]

    # ------------------------------------------------------------ montagem
    def _rascunho(self, p, ctx):
        r = {"desc": p["desc"], "valor": p["valor"], "parcelas": p["parcelas"], "data": p["data"],
             "cartao_i": 0 if len(ctx["cartoes"]) == 1 else None, "cat_i": None, "sub_i": None, "sub_perguntada": False,
             "pessoas": [0], "div_pct": None, "fixo": False, "lembrar": True, "regra_id": None, "regra_nome": None}
        regra = aplicar_regra(p["desc"], ctx["regras"])
        if not regra:
            try:
                regra = self._historico(p["desc"])
            except Exception:                                  # a sugestão é só um bônus: nunca atrapalha o lançamento
                regra = None
        if regra:
            ids_cat = [c["id"] for c in ctx["categorias"]]
            if regra.get("cat_id") in ids_cat:
                r["cat_i"] = ids_cat.index(regra["cat_id"])
                subs = [s["id"] for s in ctx["categorias"][r["cat_i"]]["subcategorias"]]
                if regra.get("subcat_id") in subs:
                    r["sub_i"] = subs.index(regra["subcat_id"])
                r["sub_perguntada"] = True
            ids_p = [x["id"] for x in ctx["pessoas"]]
            pct = {d["pessoa_id"]: float(d.get("pct", 0)) for d in regra.get("divisao") or [] if d.get("pessoa_id") in ids_p}
            if pct:
                r["pessoas"] = sorted(ids_p.index(i) for i in pct)
                r["div_pct"] = pct
            r["fixo"] = bool(regra.get("fixo"))
            r["regra_id"] = regra.get("id")
            r["regra_nome"] = regra.get("nome")
            r["historia_n"] = regra.get("n")
        return r

    def _valor_parcela(self, r):
        return round(r["valor"] / r["parcelas"], 2) if r["parcelas"] > 1 else r["valor"]

    def _seguir(self, e, modo):
        """Mostra o próximo passo que falta (cartão -> categoria -> subcategoria) ou o resumo."""
        r, ctx = e["rasc"], e["ctx"]
        if r["cartao_i"] is None:
            e["passo"] = "cartao"
        elif r["cat_i"] is None:
            e["passo"] = "cat"
        elif ctx["categorias"][r["cat_i"]]["subcategorias"] and not r["sub_perguntada"]:
            e["passo"] = "sub"
        else:
            e["passo"] = "resumo"
        return self._tela(e, modo)

    def _pessoas_txt(self, r, ctx):
        nomes = [ctx["pessoas"][i]["nome"] for i in r["pessoas"]]
        if r.get("div_pct") and len(nomes) > 1:
            return " · ".join(f"{ctx['pessoas'][i]['nome']} {r['div_pct'][ctx['pessoas'][i]['id']]:g}%" for i in r["pessoas"])
        return ", ".join(nomes) + (" (por igual)" if len(nomes) > 1 else "")

    def _tela(self, e, modo, aviso=None):
        n, r, ctx, passo = e["n"], e["rasc"], e["ctx"], e["passo"]
        b = lambda rot, acao, arg="": (rot, f"{n}|{acao}|{arg}")
        if passo == "cartao":
            botoes = [[b(c["nome"], "cartao", i)] for i, c in enumerate(ctx["cartoes"])]
            botoes.append([b("❌ Cancelar", "cancelar")])
            return {"modo": modo, "texto": self._cabecalho(r) + "\n\n💳 <b>Em qual cartão?</b>", "botoes": botoes}
        if passo == "cat":
            botoes = self._grade([b(c["nome"], "cat", i) for i, c in enumerate(ctx["categorias"])])
            botoes.append([b("❌ Cancelar", "cancelar")])
            return {"modo": modo, "texto": self._cabecalho(r) + "\n\n📂 <b>Qual a categoria?</b>", "botoes": botoes}
        if passo == "sub":
            subs = ctx["categorias"][r["cat_i"]]["subcategorias"]
            botoes = self._grade([b(s["nome"], "sub", i) for i, s in enumerate(subs)])
            botoes.append([b("Sem subcategoria", "sub", "-")])
            return {"modo": modo, "texto": self._cabecalho(r) + f"\n\n📂 <b>Subcategoria de {_e(ctx['categorias'][r['cat_i']]['nome'])}?</b>", "botoes": botoes}
        if passo == "pes":
            botoes = [[b(("☑️ " if i in r["pessoas"] else "⬜ ") + p["nome"], "pes", i)] for i, p in enumerate(ctx["pessoas"])]
            botoes.append([b("✅ Pronto", "pes", "ok")])
            return {"modo": modo, "texto": self._cabecalho(r) + "\n\n👥 <b>De quem é este gasto?</b>\nMarque uma ou mais pessoas (com mais de uma, divido por igual).",
                    "botoes": botoes}
        if passo == "data":
            h = self._hoje_base()
            dias = [(h - timedelta(days=i), r_) for i, r_ in enumerate(("Hoje", "Ontem", "Anteontem"))]
            botoes = [[b(f"{r_} ({d.strftime('%d/%m')})", "data", i)] for i, (d, r_) in enumerate(dias)]
            botoes.append([b("⬅ Voltar", "data", "voltar")])
            return {"modo": modo, "texto": self._cabecalho(r) + "\n\n📅 <b>Qual a data da compra?</b>\nToque numa opção ou digite a data (ex.: <code>05/10</code>).",
                    "botoes": botoes}
        if passo == "corrigir":
            return {"modo": modo, "botoes": [[b("⬅ Voltar", "data", "voltar")]],
                    "texto": self._cabecalho(r) + "\n\n✏️ <b>O que está errado?</b> Digite o certo:\n"
                             "• só o nome: <code>Uber</code>\n• só o valor: <code>45,90</code>\n• os dois: <code>Uber 45,90</code>\n"
                             "Também aceito <code>3x</code> (parcelas) e uma data como <code>05/10</code>."}
        return self._resumo(e, modo, aviso)

    @staticmethod
    def _grade(botoes, por_linha=2):
        return [botoes[i:i + por_linha] for i in range(0, len(botoes), por_linha)]

    def _cabecalho(self, r):
        v = moeda(r["valor"])
        quando = "hoje" if r["data"] == self._hoje_base().isoformat() else dia_mes(r["data"])
        if r["parcelas"] > 1:
            v = f"{r['parcelas']}x de {moeda(self._valor_parcela(r))} (total {moeda(r['valor'])})"
        return f"📝 {r.get('prefixo', '')}<b>{_e(r['desc'])}</b>\n💰 {v} · {quando}"

    def _resumo(self, e, modo, aviso=None):
        n, r, ctx = e["n"], e["rasc"], e["ctx"]
        b = lambda rot, acao, arg="": (rot, f"{n}|{acao}|{arg}")
        cartao = ctx["cartoes"][r["cartao_i"]]
        cat = ctx["categorias"][r["cat_i"]]
        sub = cat["subcategorias"][r["sub_i"]]["nome"] if r["sub_i"] is not None else None
        mes = dados_mod.mes_da_fatura(r["data"], cartao)
        linhas = [self._cabecalho(r),
                  f"💳 {_e(cartao['nome'])} · fatura de {mes_rotulo(mes)}",
                  f"📂 {_e(cat['nome'])}" + (f" › {_e(sub)}" if sub else ""),
                  f"👥 {_e(self._pessoas_txt(r, ctx))}",
                  f"🔁 Dívida fixa: {'sim' if r['fixo'] else 'não'}"]
        if r.get("regra_id"):
            linhas.append("🧠 Preenchi pelo que você já usou antes para esse gasto.")
        elif r.get("historia_n"):
            linhas.append(f"🧠 Sugeri a categoria pelo seu histórico com esse estabelecimento ({r['historia_n']} lançamento(s)). Confira.")
        parecidos = self._parecidos(cartao["id"], self._valor_parcela(r), r["data"])
        for p in parecidos[:2]:
            linhas.append(f"⚠️ Já existe algo parecido: {_e(p['desc'])} · {moeda(p['valor_parcela'])} · {dia_mes(p['data_compra'])}"
                          f" (fatura {mes_rotulo(p['mes_fatura'])})")
        if aviso:
            linhas.append("⚠️ " + _e(aviso))
        botoes = [[b("✅ Lançar", "lancar")],
                  [b("💳 Cartão", "editar", "cartao"), b("📂 Categoria", "editar", "cat")],
                  [b("👥 De quem", "editar", "pes"), b(f"🔁 Fixa: {'sim' if r['fixo'] else 'não'}", "fixo")],
                  [b("📅 Data", "data", "abrir"), b("✏️ Corrigir", "corrigir")],
                  [b(f"🧠 Lembrar: {'sim' if r['lembrar'] else 'não'}", "lembrar"), b("❌ Cancelar", "cancelar")]]
        return {"modo": modo, "texto": "\n".join(linhas), "botoes": botoes}

    def _gravar(self, chat, e):
        r, ctx = e["rasc"], e["ctx"]
        payload = dados_mod.montar_payload(r, ctx, self._valor_parcela(r))
        try:
            res = self._lancar(payload)
        except Exception:
            return {"modo": "editar", "texto": "😕 Não consegui lançar agora. Seu gasto não foi salvo. Tente de novo em instantes.",
                    "botoes": [[("🔁 Tentar de novo", f"{e['n']}|lancar|")]]}
        if not res.get("ok"):
            return {"modo": "editar", "texto": "😕 O programa não aceitou: " + _e(res.get("mensagem") or "erro desconhecido"),
                    "botoes": [[("💳 Cartão", f"{e['n']}|editar|cartao"), ("📂 Categoria", f"{e['n']}|editar|cat")]]}
        cartao = ctx["cartoes"][r["cartao_i"]]
        mes = payload["mes_fatura"]
        self.estados.pop(chat, None)
        n = r["parcelas"]
        extra = f"\n{n} parcelas, de {mes_rotulo(mes)} em diante." if n > 1 else ""
        return {"modo": "editar", "botoes": [],
                "texto": (f"✅ <b>Lançado!</b>\n{_e(r['desc'])} · {moeda(r['valor'])}\n💳 {_e(cartao['nome'])} · fatura de {mes_rotulo(mes)}{extra}\n\n"
                          "Errou? No programa, aperte Ctrl+Z.")}

    # ------------------------------------------------------------ prints (imagem lida pelo OCR)
    def imagem(self, chat, lido, legenda="", dia=None, fila=False):
        """lido: resultado de leitura.interpretar(). A data e a categoria NUNCA vêm do print."""
        itens = lido.get("itens") or []
        if fila and itens and self.estados.get(chat):
            self._fila.setdefault(chat, []).append(("img", lido, legenda, dia))
            return []
        self._dia = dia
        if not itens:
            return [self._msg("🤔 Não achei nenhuma compra nesse print. Tente um print mais nítido (só a lista ou a notificação) "
                              "ou mande o gasto em texto, ex.: <code>45,90 uber</code>.")]
        ctx = self._carregar()
        if not ctx["cartoes"] or not ctx["categorias"] or not ctx["pessoas"]:
            return [self._msg("Antes preciso que o programa tenha pelo menos um cartão, uma categoria e uma pessoa cadastrados.")]
        base = {"data": self._hoje().isoformat(), "parcelas": 1}
        if legenda:
            p, erro = entender_parcial(legenda, self._hoje())
            if not erro:
                base["data"] = p.get("data", base["data"])
                base["parcelas"] = p.get("parcelas", 1)
        self.estados.pop(chat, None)
        cartao_i = self._cartao_dica(ctx, lido)
        final = lido.get("final")
        if len(itens) == 1:
            e = self._abrir_item(chat, ctx, itens[0], base, cartao_i, final, None)
            return [self._seguir(e, "novo")]
        self._contador += 1
        dups = [bool(self._parecidos_lista(it["valor"], it["desc"])) for it in itens]
        e = {"n": self._contador, "ctx": ctx, "passo": "lista", "espera": None, "dia": self._dia,
             "lista": {"itens": itens, "dups": dups, "marcados": {i for i, d in enumerate(dups) if not d},
                       "base": base, "cartao_i": cartao_i, "final": final, "cortado": bool(lido.get("cortado"))}}
        self.estados[chat] = e
        return [self._tela_lista(e, "novo")]

    def _cartao_dica(self, ctx, lido):
        ids = [c["id"] for c in ctx["cartoes"]]
        if lido.get("final") and self._finais:
            cid = self._finais.get(lido["final"])
            if cid in ids:
                return ids.index(cid)
        banco = lido.get("banco")
        if banco:
            achados = [i for i, c in enumerate(ctx["cartoes"]) if banco in sem_acento(c["nome"])]
            if len(achados) == 1:
                return achados[0]
        return None

    def _abrir_item(self, chat, ctx, item, base, cartao_i, final, lote, fila=None):
        self._contador += 1
        parsed = {"desc": item["desc"], "valor": item["valor"], "parcelas": base["parcelas"], "data": base["data"]}
        r = self._rascunho(parsed, ctx)
        if cartao_i is not None:
            r["cartao_i"] = cartao_i
        r["prefixo"] = self._quando_enviada(self._dia, self._hoje_base())
        if lote:
            r["prefixo"] += f"({lote['pos']} de {lote['total']}) "
        e = {"n": self._contador, "ctx": ctx, "rasc": r, "passo": "resumo", "espera": None,
             "final": final, "lote": lote, "fila": fila or [], "base": base, "dia": self._dia}
        self.estados[chat] = e
        return e

    def _proximo(self, chat, e):
        lote = e["lote"]
        if not e["fila"]:
            return [self._msg(f"🏁 Pronto! Lancei {lote['ok']} de {lote['total']} compras do print."
                              + (f" (puladas: {lote['pulados']})" if lote["pulados"] else ""))]
        lote["pos"] += 1
        prox = self._abrir_item(chat, e["ctx"], e["fila"][0], e["base"], lote["cartao_i"], e["final"], lote, e["fila"][1:])
        return [self._seguir(prox, "novo")]

    def _tela_lista(self, e, modo, aviso=None):
        n, L = e["n"], e["lista"]
        b = lambda rot, acao, arg="": (rot, f"{n}|{acao}|{arg}")
        if e["passo"] == "data":
            h = self._hoje_base()
            botoes = [[b(f"{nome} ({(h - timedelta(days=i)).strftime('%d/%m')})", "data", i)] for i, nome in enumerate(("Hoje", "Ontem", "Anteontem"))]
            botoes.append([b("⬅ Voltar", "data", "voltar")])
            return {"modo": modo, "botoes": botoes,
                    "texto": "📅 <b>Qual a data dessas compras?</b>\nToque numa opção ou digite a data (ex.: <code>05/10</code>)."}
        botoes = []
        for i, it in enumerate(L["itens"]):
            rot = ("☑️ " if i in L["marcados"] else "⬜ ") + ("⚠️ " if L["dups"][i] else "") + f"{it['desc'][:26]} · {moeda(it['valor'])}"
            botoes.append([b(rot, "tgl", i)])
        d = L["base"]["data"]
        quando = "hoje" if d == self._hoje_base().isoformat() else dia_mes(d)
        botoes.append([b(f"📅 Data: {quando}", "data", "abrir")])
        botoes.append([b(f"✅ Lançar {len(L['marcados'])} compra(s)", "go")])
        botoes.append([b("❌ Cancelar", "cancelar")])
        linhas = [f"📷 Li <b>{len(L['itens'])}</b> compras no print. Marque as que quer lançar:",
                  "⚠️ = parece que já está lançada (deixei desmarcada).", f"📅 Data: {quando} (a data do print eu não uso)."]
        if L.get("cortado"):
            linhas.append("Só considerei as primeiras; mande o resto num novo print.")
        if aviso:
            linhas.append("⚠️ " + _e(aviso))
        return {"modo": modo, "texto": "\n".join(linhas), "botoes": botoes}

    def _botao_lista(self, chat, e, acao, arg):
        L = e["lista"]
        if acao == "cancelar":
            self.estados.pop(chat, None)
            return [{"modo": "editar", "texto": "❌ Cancelado.", "botoes": []}]
        if acao == "tgl":
            i = int(arg)
            L["marcados"] ^= {i}
            return [self._tela_lista(e, "editar")]
        if acao == "data":
            if arg == "abrir":
                e["passo"], e["espera"] = "data", "data"
                return [self._tela_lista(e, "editar")]
            if arg != "voltar":
                L["base"]["data"] = (self._hoje_base() - timedelta(days=int(arg))).isoformat()
            e["passo"] = "lista"
            return [self._tela_lista(e, "editar")]
        if acao == "go":
            escolhidos = [L["itens"][i] for i in sorted(L["marcados"])]
            if not escolhidos:
                return [self._tela_lista(e, "editar", aviso="Marque pelo menos uma compra.")]
            lote = {"pos": 1, "total": len(escolhidos), "ok": 0, "pulados": 0, "cartao_i": L["cartao_i"]}
            primeiro = self._abrir_item(chat, e["ctx"], escolhidos[0], L["base"], L["cartao_i"], L["final"], lote, escolhidos[1:])
            return [{"modo": "editar", "texto": f"▶️ Vamos lançar {len(escolhidos)} compra(s), uma de cada vez.", "botoes": []},
                    self._seguir(primeiro, "novo")]
        return [self._tela_lista(e, "editar")]

    def _aplicar_data(self, e, iso):
        e["rasc"]["data"] = iso                    # só esta compra muda; as outras do print mantêm a data do lote

    def _texto_esperado(self, chat, e, t):
        """A pessoa tocou em 📅 Data ou ✏️ Corrigir e agora digitou a resposta. None = não era resposta (vira gasto novo)."""
        p, erro = entender_parcial(t, self._hoje())
        if e["espera"] == "data":
            if erro or "data" not in p:
                return None
            if "lista" in e:
                e["lista"]["base"]["data"] = p["data"]
                e["passo"], e["espera"] = "lista", None
                return [self._tela_lista(e, "novo")]
            self._aplicar_data(e, p["data"])
            e["espera"] = None
            return [self._seguir(e, "novo")]
        if "lista" in e:
            return None
        if erro:
            return [self._msg("🤔 " + erro)]
        if not p:
            return [self._msg("Não entendi. Digite o nome e/ou o valor certos, por exemplo: <code>Uber 45,90</code>.")]
        r = e["rasc"]
        for k in ("desc", "valor", "parcelas", "data"):
            if k in p:
                r[k] = p[k]
        e["espera"] = None
        return [self._seguir(e, "novo")]

    @staticmethod
    def _msg(texto, modo="novo"):
        return {"modo": modo, "texto": texto, "botoes": []}
