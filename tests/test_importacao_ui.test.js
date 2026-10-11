// Testa as contas da tela de importação (sem navegador).  Rodar: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'importacao.js'), 'utf-8'), ctx);
const P = ctx.ImportacaoPuras;
const J = (x) => JSON.parse(JSON.stringify(x));   // objetos do vm têm outro 'prototype'

const soma = (l) => Math.round(l.reduce((s, x) => s + x.valor, 0) * 100) / 100;

test('normalizar tira acento e símbolos', () => {
    assert.strictEqual(P.normalizar('DL *UBERRIDES  Ção'), 'dl uberrides cao');
});

test('dividirValor nunca perde nem inventa centavo', () => {
    for (const v of [10, 0.01, 33.33, 100.01, 1234.56, -9.99, 0.05]) {
        for (const pcts of [[50, 50], [33.33, 33.33, 33.34], [70, 30], [100], [10, 20, 70]]) {
            const lista = pcts.map((p, i) => ({ pessoa_id: 'p' + i, pct: p }));
            assert.strictEqual(soma(P.dividirValor(v, lista)), v, `${v} em ${pcts}`);
        }
    }
});

test('dividirValor ignora quem tem 0%', () => {
    const r = P.dividirValor(10, [{ pessoa_id: 'a', pct: 100 }, { pessoa_id: 'b', pct: 0 }]);
    assert.deepStrictEqual(J(r), [{ pessoa_id: 'a', valor: 10 }]);
});

test('dividirIgual: centavos que sobram vão para os primeiros, soma sempre fecha', () => {
    assert.deepStrictEqual(J(P.dividirIgual(10, ['a', 'b', 'c'])), [{ pessoa_id: 'a', valor: 3.34 }, { pessoa_id: 'b', valor: 3.33 }, { pessoa_id: 'c', valor: 3.33 }]);
    assert.deepStrictEqual(J(P.dividirIgual(100, ['a', 'b'])), [{ pessoa_id: 'a', valor: 50 }, { pessoa_id: 'b', valor: 50 }]);
    assert.strictEqual(P.somaDiv(P.dividirIgual(-10, ['a', 'b', 'c'])), -10);
    assert.deepStrictEqual(J(P.dividirIgual(61.46, ['a'])), [{ pessoa_id: 'a', valor: 61.46 }]);
    for (const v of [0.01, 0.02, 33.33, 1234.56, -9.99]) for (let n = 1; n <= 6; n++)
        assert.strictEqual(P.somaDiv(P.dividirIgual(v, Array.from({ length: n }, (_, i) => 'p' + i))), v);
});

test('faltaDiv mostra quanto falta (ou passou) distribuir', () => {
    assert.strictEqual(P.faltaDiv(100, [{ pessoa_id: 'a', valor: 60 }]), 40);
    assert.strictEqual(P.faltaDiv(100, [{ pessoa_id: 'a', valor: 60 }, { pessoa_id: 'b', valor: 40 }]), 0);
    assert.strictEqual(P.faltaDiv(100, [{ pessoa_id: 'a', valor: 120 }]), -20);
    assert.strictEqual(P.faltaDiv(0.3, [{ pessoa_id: 'a', valor: 0.1 }, { pessoa_id: 'b', valor: 0.2 }]), 0);
});

test('pctsDe converte reais em porcentagem para as regras', () => {
    assert.deepStrictEqual(J(P.pctsDe([{ pessoa_id: 'a', valor: 25 }, { pessoa_id: 'b', valor: 75 }], 100)),
        [{ pessoa_id: 'a', pct: 25 }, { pessoa_id: 'b', pct: 75 }]);
});

const L = (o) => ({ incluir: true, valor: 10, nome: 'A', div: [{ pessoa_id: 'a', valor: 10 }], validada: false, ...o });

test('resumo conta pendências e validações', () => {
    const r = P.resumo([L({}), L({ nome: ' ' }), L({ div: [{ pessoa_id: 'a', valor: 6 }] }), L({ incluir: false }), L({ validada: true })]);
    assert.deepStrictEqual({ ...r }, { importar: 4, total: 40, ignoradas: 1, pendentes: 2, validadas: 1, naoValidadas: 3 });
});

test('cartão padrão: pelos 4 últimos dígitos, senão pelo emissor, senão vazio', () => {
    const cs = [{ id: 'a', nome: 'XP 9258' }, { id: 'b', nome: 'Inter' }];
    assert.strictEqual(P.chaveCartaoPadrao({ final: '9258' }, 'xp', cs), 'a');
    assert.strictEqual(P.chaveCartaoPadrao({ final: '1111' }, 'inter', cs), 'b');
    assert.strictEqual(P.chaveCartaoPadrao({ final: '1111' }, 'xp', [{ id: 'a', nome: 'X' }]), '');
    assert.strictEqual(P.chaveCartaoPadrao({ final: '1' }, 'xp', [{ id: 'a', nome: 'XP' }, { id: 'c', nome: 'XP 2' }]), '');
});

const fatura = { emissor: 'xp', vencimento: '2026-10-10', total_fatura: 100, secoes: [
    { linhas: [{ seq: 1, data: '2026-09-02', descricao: 'UBER', descricao_original: 'UBER', valor: 20, valor_usd: null, parcela_atual: null, total_parcelas: null },
              { seq: 2, data: '2026-09-03', descricao: 'LOJA', descricao_original: 'LOJA - Parcela 3/5', valor: 50.5, valor_usd: null, parcela_atual: 3, total_parcelas: 5 },
              { seq: 3, data: '2026-09-04', descricao: 'UBER', descricao_original: 'UBER', valor: 15, valor_usd: null, parcela_atual: null, total_parcelas: null }] }] };
const sug = [
    { seq: 1, acao: 'lancar', motivo: 'nova', nome: 'Uber', divisao_pct: [{ pessoa_id: 'p1', pct: 100 }], modo: 'so_esta', avisos: [] },
    { seq: 2, acao: 'lancar', motivo: 'nova', nome: 'Loja', divisao_pct: [{ pessoa_id: 'p1', pct: 100 }], modo: 'esta_e_seguintes', avisos: [] },
    { seq: 3, acao: 'ignorar', motivo: 'ja_lancada', nome: 'Uber', divisao_pct: [{ pessoa_id: 'p1', pct: 100 }], modo: 'so_esta', avisos: [] }];

const estado = (linhas) => ({ linhas, mapeamento: { 0: 'c1' }, mes: '2026-10', fatura, arquivo: { hash: 'h', nome: 'f.pdf' } });

test('montarLinhas segue as sugestões e já converte a divisão para reais', () => {
    const l = P.montarLinhas(fatura, sug);
    assert.deepStrictEqual(J(l.map((x) => x.incluir)), [true, true, false]);
    assert.strictEqual(l[1].atual, 3); assert.strictEqual(l[1].total, 5); assert.strictEqual(l[0].total, 1);
    assert.deepStrictEqual(J(l[1].div), [{ pessoa_id: 'p1', valor: 50.5 }]);
});

test('payload: só linhas marcadas, divisão em reais, regras sem repetição', () => {
    const linhas = P.montarLinhas(fatura, sug);
    linhas[0].lembrar = true; linhas[0].cat_id = 'cat1';
    linhas[2].incluir = true; linhas[2].lembrar = true;   // mesma descrição => 1 regra só
    linhas[1].div = [{ pessoa_id: 'p1', valor: 30 }, { pessoa_id: 'p2', valor: 20.5 }];
    const pl = P.montarPayload(estado(linhas));
    assert.strictEqual(pl.itens.length, 3);
    assert.strictEqual(pl.regras.length, 1);
    assert.strictEqual(pl.regras[0].padrao, 'uber');
    assert.deepStrictEqual(J(pl.itens[1].divisao), [{ pessoa_id: 'p1', valor: 30 }, { pessoa_id: 'p2', valor: 20.5 }]);
    assert.strictEqual(pl.itens[1].modo, 'esta_e_seguintes');
    assert.strictEqual(pl.itens[0].modo, 'so_esta');
    assert.strictEqual(pl.itens[0].cartao_id, 'c1');
    assert.strictEqual(pl.arquivo.emissor, 'xp');
});

test('regra salva guarda porcentagem (vale para qualquer valor)', () => {
    const linhas = P.montarLinhas(fatura, sug);
    linhas[1].lembrar = true; linhas[1].div = [{ pessoa_id: 'p1', valor: 25.25 }, { pessoa_id: 'p2', valor: 25.25 }];
    const r = P.montarPayload(estado(linhas)).regras[0];
    assert.deepStrictEqual(J(r.divisao), [{ pessoa_id: 'p1', pct: 50 }, { pessoa_id: 'p2', pct: 50 }]);
});

test('última parcela nunca vira "esta e as seguintes"', () => {
    const linhas = P.montarLinhas(fatura, sug);
    linhas[1].atual = 5;
    assert.strictEqual(P.montarPayload(estado(linhas)).itens[1].modo, 'so_esta');
});

test('propagar copia nome/divisão (em proporção) só para iguais ainda não mexidas', () => {
    const linhas = P.montarLinhas(fatura, sug);
    linhas[0].nome = 'Uber Trip'; linhas[0].div = [{ pessoa_id: 'p1', valor: 10 }, { pessoa_id: 'p2', valor: 10 }];
    P.propagar(linhas, linhas[0], ['nome', 'div']);
    assert.strictEqual(linhas[2].nome, 'Uber Trip');
    assert.deepStrictEqual(J(linhas[2].div), [{ pessoa_id: 'p1', valor: 7.5 }, { pessoa_id: 'p2', valor: 7.5 }]);
    assert.strictEqual(linhas[1].nome, 'Loja');
    linhas[2].validada = true; linhas[0].nome = 'Outro';
    P.propagar(linhas, linhas[0], ['nome']);
    assert.strictEqual(linhas[2].nome, 'Uber Trip');          // validada não é alterada
});

// ---------- vínculo manual ----------
const F = (o) => ({ id: 'x' + Math.random(), id_compra_pai: 'pai1', cartao_id: 'c1', desc: 'Samsung', mes_fatura: '2026-09', valor_parcela: 61.46,
    parcela_atual: 5, total_parcelas: 10, cat_id: 'cat1', subcat_id: '', divisao: [{ pessoa_id: 'p1', valor: 41.46 }, { pessoa_id: 'p2', valor: 20 }], ...o });
const linhaVinc = () => P.montarLinhas({ secoes: [{ linhas: [{ seq: 9, data: '2026-09-20', descricao: 'MP *SAMSUNG', descricao_original: 'MP *SAMSUNG', valor: 61.46,
    valor_usd: null, parcela_atual: null, total_parcelas: null }] }] }, [{ seq: 9, acao: 'lancar', motivo: 'nova', nome: 'Samsung', divisao_pct: [{ pessoa_id: 'p1', pct: 100 }], modo: 'so_esta', avisos: [] }])[0];

test('candidatos: um por compra, melhores primeiro, só do cartão (ou todos)', () => {
    const fats = [F({ id: 'a' }), F({ id: 'b', mes_fatura: '2026-08', parcela_atual: 4 }), F({ id: 'c', id_compra_pai: 'pai2', desc: 'Padaria', valor_parcela: 5, total_parcelas: 1, parcela_atual: 1 }),
                  F({ id: 'd', id_compra_pai: 'pai3', cartao_id: 'c2', desc: 'Outro cartão' }), F({ id: 'e', id_compra_pai: 'pai4', mes_fatura: '2024-01', desc: 'Velha' })];
    const l = linhaVinc();
    const r = P.candidatosVinculo(fats, l, { cartaoId: 'c1', mes: '2026-10', busca: '', todosCartoes: false });
    assert.deepStrictEqual(J(r.map((x) => x.id)), ['a', 'c']);
    assert.strictEqual(P.candidatosVinculo(fats, l, { cartaoId: 'c1', mes: '2026-10', busca: '', todosCartoes: true }).length, 3);
    assert.deepStrictEqual(J(P.candidatosVinculo(fats, l, { cartaoId: 'c1', mes: '2026-10', busca: 'velh', todosCartoes: false }).map((x) => x.id)), ['e']);
});

test('vincular copia nome, categoria, responsáveis (em proporção) e calcula a parcela', () => {
    const l = linhaVinc();
    const ex = F({ id: 'a' });
    const r = P.aplicarVinculo(l, ex, '2026-10', [ex]);
    assert.strictEqual(r.jaLancada, false);
    assert.strictEqual(l.nome, 'Samsung'); assert.strictEqual(l.cat_id, 'cat1');
    assert.strictEqual(l.compra_pai, 'pai1');
    assert.strictEqual(l.atual, 6); assert.strictEqual(l.total, 10);
    assert.strictEqual(l.modo, 'esta_e_seguintes');
    assert.deepStrictEqual(J(l.div), [{ pessoa_id: 'p1', valor: 41.46 }, { pessoa_id: 'p2', valor: 20 }]);
    assert.strictEqual(P.montarPayload(estado([l])).itens[0].compra_pai, 'pai1');
});

test('vincular: se a compra já tem essa parcela (em QUALQUER mês), fica só o lançamento antigo', () => {
    let l = linhaVinc();
    const com = [F({ id: 'a' }), F({ id: 'g', mes_fatura: '2026-12', parcela_atual: 6, desc: 'Galaxy antigo' })];   // mês diferente do da fatura
    const r = P.aplicarVinculo(l, com[0], '2026-10', com);
    assert.strictEqual(r.jaLancada, true); assert.strictEqual(l.incluir, false);
    assert.strictEqual(l.absorvida, true); assert.strictEqual(l.motivo, 'vinculada_existente');
    assert.strictEqual(l.existente.desc, 'Galaxy antigo');
    assert.strictEqual(P.montarPayload(estado([l])).itens.length, 0);        // nada é importado
});

test('vincular a compra sem essa parcela: importa (o servidor só cria as que faltam)', () => {
    const l = linhaVinc();
    const todas = [F({ id: 'a' }), F({ id: 'f', mes_fatura: '2026-11', parcela_atual: 7 })];
    const r = P.aplicarVinculo(l, todas[0], '2026-10', todas);
    assert.strictEqual(r.jaLancada, false); assert.strictEqual(l.incluir, true); assert.strictEqual(l.modo, 'esta_e_seguintes');
});

test('vincular compra à vista a outra à vista: absorve', () => {
    const l = linhaVinc();
    const ex = F({ id: 'u', id_compra_pai: 'u', total_parcelas: 1, parcela_atual: 1, desc: 'Google' });
    P.aplicarVinculo(l, ex, '2026-10', [ex]);
    assert.strictEqual(l.absorvida, true); assert.strictEqual(l.incluir, false);
});

test('vincular usa a parcela do PDF quando a fatura traz parcela', () => {
    const l = linhaVinc(); l.parcelaPdf = true; l.atual = 6; l.total = 10;
    const ex = F({ id: 'a', total_parcelas: 12 });
    P.aplicarVinculo(l, ex, '2026-10', [ex]);
    assert.strictEqual(l.atual, 6); assert.strictEqual(l.total, 10);
});

test('fixo: vem da sugestão/regra, vai no payload e na regra, e é copiado ao vincular', () => {
    const l = linhaVinc();
    assert.strictEqual(l.fixo, false);
    l.fixo = true; l.lembrar = true;
    const pl = P.montarPayload(estado([l]));
    assert.strictEqual(pl.itens[0].fixo, true);
    assert.strictEqual(pl.regras[0].fixo, true);
    const l2 = linhaVinc();
    P.aplicarVinculo(l2, F({ id: 'a', fixo: true }), '2026-10', [F({ id: 'a', fixo: true })]);
    assert.strictEqual(l2.fixo, true);
    const dados = P.montarLinhas({ secoes: [{ linhas: [{ seq: 1, data: '2026-09-02', descricao: 'X', descricao_original: 'X', valor: 5, valor_usd: null, parcela_atual: null, total_parcelas: null }] }] },
        [{ seq: 1, acao: 'lancar', motivo: 'nova', nome: 'X', fixo: true, divisao_pct: [{ pessoa_id: 'p1', pct: 100 }], modo: 'so_esta', avisos: [] }]);
    assert.strictEqual(dados[0].fixo, true);
});
