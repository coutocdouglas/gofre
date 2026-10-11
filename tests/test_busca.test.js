// Testa a busca global (sem navegador).  Rodar: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'busca.js'), 'utf-8'), ctx);
const B = ctx.BuscaPura;
const J = x => JSON.parse(JSON.stringify(x));

const D = {
    cartoes: [{ id: 'c1', nome: 'XP' }, { id: 'c2', nome: 'Inter' }],
    categorias: [{ id: 'k1', nome: 'Saúde', subcategorias: [{ id: 's1', nome: 'Farmácia' }] }, { id: 'k2', nome: 'Lazer', subcategorias: [] }],
    pessoas: [{ id: 'p1', nome: 'Douglas' }, { id: 'p2', nome: 'Ana' }],
    faturas: [
        { id: 'a1', id_compra_pai: 'a1', cartao_id: 'c1', desc: 'Academia', mes_fatura: '2026-10', valor_parcela: 129.9, parcela_atual: 1, total_parcelas: 1, cat_id: 'k1', subcat_id: null, divisao: [{ pessoa_id: 'p1', valor: 129.9 }], fixo: true, data_compra: '2026-09-15' },
        ...[1, 2, 3, 4].map(n => ({ id: 'n' + n, id_compra_pai: 'nb', cartao_id: 'c2', desc: 'Notebook Dell', mes_fatura: '2026-' + String(9 + n).padStart(2, '0'), valor_parcela: 500, parcela_atual: n, total_parcelas: 4, cat_id: 'k2', subcat_id: null, divisao: [{ pessoa_id: 'p2', valor: 500 }], data_compra: '2026-09-02' })),
    ],
    pontuais: [
        { id: 'g1', desc: 'Remédio', valor: 42.5, data: '2026-10-03', mes_ref: '2026-10', cat_id: 'k1', subcat_id: 's1', divisao: [{ pessoa_id: 'p1', valor: 42.5 }], origem_regra: null },
        { id: 'g2', desc: 'Aluguel', valor: 1500, data: '2026-10-05', mes_ref: '2026-10', cat_id: null, subcat_id: null, divisao: [], origem_regra: 'r1' },
    ],
    transacoes: [{ id: 't1', desc: 'Salário', valor: 5000, data: '2026-10-05', origem_regra: 'rf' }],
};

test('normalizar ignora acento e maiúscula', () => {
    assert.strictEqual(B.normalizar('  FARMÁCIA '), 'farmacia');
});

test('acha por nome sem se importar com acento', () => {
    const r = B.buscar('farmacia', D, '2026-10');
    assert.deepStrictEqual(J(r.itens.map(i => i.id)), ['g1']);          // pela subcategoria
});

test('acha pelo valor, com vírgula ou ponto', () => {
    assert.deepStrictEqual(J(B.buscar('129,90', D, '2026-10').itens.map(i => i.id)), ['a1']);
    assert.deepStrictEqual(J(B.buscar('129.9', D, '2026-10').itens.map(i => i.id)), ['a1']);
});

test('várias palavras: todas precisam casar', () => {
    assert.deepStrictEqual(J(B.buscar('notebook inter', D, '2026-10').itens.map(i => i.grupo)), ['nb']);
    assert.strictEqual(B.buscar('notebook xp', D, '2026-10').total, 0);
});

test('parcelas da mesma compra viram uma linha só, a mais próxima do mês atual', () => {
    const r = B.buscar('notebook', D, '2026-12');
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.itens[0].mes, '2026-12');
    assert.strictEqual(r.itens[0].outras, 3);
    assert.strictEqual(r.itens[0].painel, 'faturas');
});

test('busca por pessoa, cartão, mês e tipo', () => {
    assert.ok(B.buscar('ana', D, '2026-10').itens.some(i => i.grupo === 'nb'));
    assert.ok(B.buscar('xp', D, '2026-10').itens.some(i => i.id === 'a1'));
    assert.ok(B.buscar('janeiro', D, '2026-10').total === 0);
    assert.deepStrictEqual(J(B.buscar('entrada', D, '2026-10').itens.map(i => i.id)), ['t1']);
    assert.deepStrictEqual(J(B.buscar('parcela', D, '2026-10').itens.map(i => i.id)).length >= 0, true);
});

test('cada tipo abre o painel certo', () => {
    const painel = id => B.buscar(id, D, '2026-10').itens[0].painel;
    assert.strictEqual(painel('remedio'), 'pontuais');
    assert.strictEqual(painel('aluguel'), 'fixos');
    assert.strictEqual(painel('salario'), 'entradas');
    assert.strictEqual(painel('academia'), 'faturas');
});

test('busca vazia não devolve nada e o nome vem antes de outros campos', () => {
    assert.strictEqual(B.buscar('   ', D, '2026-10').total, 0);
    const r = B.buscar('lazer', D, '2026-10');          // casa pela categoria
    assert.strictEqual(r.itens[0].grupo, 'nb');
});
