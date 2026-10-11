// Testa as contas dos Relatórios e do Fechar mês (sem navegador).  Rodar: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'relatorios.js'), 'utf-8'), ctx);
const R = ctx.RelatoriosPuro;

const D = {
    idPrincipal: 'p1',
    categorias: [{ id: 'k1', nome: 'Saúde', subcategorias: [{ id: 's1', nome: 'Farmácia' }] }, { id: 'k2', nome: 'Lazer', subcategorias: [] }],
    cartoes: [{ id: 'c1', nome: 'XP' }],
    faturas: [
        { id: 'a1', cartao_id: 'c1', desc: 'Academia', mes_fatura: '2026-10', valor_parcela: 100, parcela_atual: 1, total_parcelas: 1, cat_id: 'k1', subcat_id: 's1', fixo: true, data_compra: '2026-09-15', divisao: [{ pessoa_id: 'p1', valor: 100 }] },
        { id: 'a2', cartao_id: 'c1', desc: 'Notebook', mes_fatura: '2026-10', valor_parcela: 500, parcela_atual: 2, total_parcelas: 4, cat_id: 'k2', subcat_id: '', data_compra: '2026-08-02', divisao: [{ pessoa_id: 'p1', valor: 200 }, { pessoa_id: 'p2', valor: 300 }] },
        { id: 'a3', cartao_id: 'c1', desc: 'Presente da Ana', mes_fatura: '2026-10', valor_parcela: 80, parcela_atual: 1, total_parcelas: 1, cat_id: 'k2', divisao: [{ pessoa_id: 'p2', valor: 80 }] },   // só de terceiros
        { id: 'a4', cartao_id: 'c1', desc: 'Notebook', mes_fatura: '2026-11', valor_parcela: 500, parcela_atual: 3, total_parcelas: 4, cat_id: 'k2', divisao: [{ pessoa_id: 'p1', valor: 200 }, { pessoa_id: 'p2', valor: 300 }] },
        { id: 'a5', cartao_id: 'c1', desc: 'Sem categoria', mes_fatura: '2026-10', valor_parcela: 10, parcela_atual: 1, total_parcelas: 1, cat_id: null, divisao: [{ pessoa_id: 'p1', valor: 10 }] },
    ],
    pontuais: [
        { id: 'g1', desc: 'Remédio', mes_ref: '2026-10', cat_id: 'k1', subcat_id: 's1', origem_regra: null, pago: true, data: '2026-10-03', divisao: [{ pessoa_id: 'p1', valor: 40 }] },
        { id: 'g2', desc: 'Aluguel', mes_ref: '2026-10', cat_id: 'k2', origem_regra: 'r1', pago: false, data: '2026-10-05', divisao: [{ pessoa_id: 'p1', valor: 1000 }, { pessoa_id: 'p2', valor: 500 }] },
        { id: 'g3', desc: 'Remédio', mes_ref: '2026-09', cat_id: 'k1', origem_regra: null, pago: true, divisao: [{ pessoa_id: 'p1', valor: 30 }] },
    ],
    transacoes: [{ id: 't1', valor: 5000, data: '2026-10-05' }, { id: 't2', valor: 4000, data: '2026-09-05' }],
    pagamentosFatura: [],
};

test('intervalo respeita o mês mínimo e a ordem', () => {
    assert.deepStrictEqual(Array.from(R.intervalo('2026-10', 3)), ['2026-08', '2026-09', '2026-10']);
    assert.deepStrictEqual(Array.from(R.intervalo('2026-05', 6)), ['2026-04', '2026-05']);          // nunca antes de abril/2026
    assert.deepStrictEqual(Array.from(R.intervalo('2027-01', 2)), ['2026-12', '2027-01']);
    assert.strictEqual(R.rotuloMes('2026-10'), 'out/26');
});

test('só a parte do principal entra; terceiros ficam de fora', () => {
    const m = R.calcularMes(D, '2026-10');
    assert.strictEqual(m.cartao, 100 + 200 + 10);              // Academia + 40% do Notebook + sem categoria; "Presente da Ana" não conta
    assert.strictEqual(m.fixos, 1000);                         // só a parte do principal no aluguel
    assert.strictEqual(m.pontuais, 40);
    assert.strictEqual(m.gastos, 310 + 1000 + 40);             // academia fixa no cartão NÃO soma de novo
    assert.strictEqual(m.entradas, 5000);
    assert.strictEqual(m.saldo, 5000 - 1350);
    assert.ok(!m.itens.some(i => i.desc === 'Presente da Ana'));
});

test('categorias e subcategorias do mês', () => {
    const m = R.calcularMes(D, '2026-10');
    assert.strictEqual(m.categorias.k1.total, 100 + 40);
    assert.strictEqual(m.categorias.k2.total, 200 + 1000);
    assert.strictEqual(m.categorias[''].total, 10);            // sem categoria
    const subs = R.subcategoriasDoMes(m, 'k1', D.categorias);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(subs)), [{ nome: 'Farmácia', valor: 140 }]);
});

test('série, variação e tabela de categorias', () => {
    const meses = R.intervalo('2026-10', 2);
    const serie = R.calcularSerie(D, meses);
    assert.strictEqual(serie[0].gastos, 30);
    assert.strictEqual(serie[1].gastos, 1350);
    const v = R.variacao(serie[1].gastos, serie[0].gastos);
    assert.strictEqual(v.dif, 1320);
    assert.strictEqual(Math.round(v.pct), 4400);
    assert.strictEqual(R.variacao(10, 0).pct, null);            // mês anterior zerado: sem porcentagem
    const cats = R.categoriasDaSerie(serie, D.categorias);
    assert.strictEqual(cats[0].nome, 'Lazer');                  // a que mais pesou no período vem primeiro
    const saude = cats.find(c => c.nome === 'Saúde');
    assert.deepStrictEqual(Array.from(saude.valores), [30, 140]);
    assert.strictEqual(saude.variacao.dif, 110);
    assert.ok(cats.some(c => c.nome === R.SEM_CATEGORIA));
});

test('meses futuros mostram o que já está lançado (parcelas)', () => {
    const m = R.calcularMes(D, '2026-11');
    assert.strictEqual(m.cartao, 200);
    assert.strictEqual(m.entradas, 0);
});

test('maiores gastos ordenados', () => {
    const top = R.maioresGastos(R.calcularMes(D, '2026-10'), 3);
    assert.deepStrictEqual(Array.from(top.map(i => i.desc)), ['Aluguel', 'Notebook (2/4)', 'Academia']);
    assert.strictEqual(top[1].valor, 200);
});

test('pendências: só os seus pagamentos', () => {
    const p = R.pendencias(D, '2026-10');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.gastosNaoPagos)), [{ desc: 'Aluguel', valor: 1000 }]);
    assert.strictEqual(p.faturasNaoPagas.length, 1);
    assert.strictEqual(p.faturasNaoPagas[0].cartao, 'XP');
    assert.strictEqual(p.semCategoria, 1);
    const D2 = Object.assign({}, D, { pagamentosFatura: [{ cartao_id: 'c1', mes: '2026-10', pago: true }] });
    assert.strictEqual(R.pendencias(D2, '2026-10').faturasNaoPagas.length, 0);
});

test('fechamento: foto dos números e aviso de mudança', () => {
    const m = R.calcularMes(D, '2026-10');
    const foto = R.resumoParaSalvar(m, D.categorias);
    assert.strictEqual(foto.categorias[0].nome, 'Lazer');
    const fechado = { gastos: m.gastos, entradas: m.entradas };
    assert.strictEqual(R.mudouDesdeOFechamento(m, fechado).mudou, false);
    D.pontuais.push({ id: 'g9', desc: 'Novo', mes_ref: '2026-10', cat_id: 'k2', pago: true, divisao: [{ pessoa_id: 'p1', valor: 25 }] });
    const depois = R.calcularMes(D, '2026-10');
    const mud = R.mudouDesdeOFechamento(depois, fechado);
    assert.strictEqual(mud.mudou, true);
    assert.strictEqual(mud.difGastos, 25);
    D.pontuais.pop();
});
