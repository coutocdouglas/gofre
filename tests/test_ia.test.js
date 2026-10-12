// Testa o resumo que a IA recebe (sem navegador).  Rodar: node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['relatorios.js', 'ia.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', f), 'utf-8'), ctx);
const IA = ctx.IAPuro;

const D = {
    idPrincipal: 'p1',
    categorias: [{ id: 'k1', nome: 'Saúde', subcategorias: [] }, { id: 'k2', nome: 'Lazer', subcategorias: [] }],
    cartoes: [{ id: 'c1', nome: 'XP' }],
    faturas: [
        { id: 'a1', cartao_id: 'c1', desc: 'Netflix Secreta', mes_fatura: '2026-10', valor_parcela: 100, parcela_atual: 1, total_parcelas: 1, cat_id: 'k2', divisao: [{ pessoa_id: 'p1', valor: 100 }] },
        { id: 'a2', cartao_id: 'c1', desc: 'Notebook', mes_fatura: '2026-11', valor_parcela: 500, parcela_atual: 2, total_parcelas: 4, cat_id: 'k2', divisao: [{ pessoa_id: 'p1', valor: 500 }] },
    ],
    pontuais: [{ id: 'g1', desc: 'Remédio Particular', mes_ref: '2026-10', cat_id: 'k1', origem_regra: null, pago: false, data: '2026-10-03', divisao: [{ pessoa_id: 'p1', valor: 40 }] }],
    transacoes: [{ id: 't1', valor: 5000, data: '2026-10-05' }],
    pagamentosFatura: [],
};

test('resumo traz totais, orçamento e compromissos futuros', () => {
    const t = IA.montarContexto(D, { fim: '2026-10', qtd: 6, descricoes: false, orcamentos: [{ cat_id: 'k2', subcat_id: '', mes: '2026-10', valor: 80 }] });
    assert.match(t, /entradas R\$ 5\.000,00/);
    assert.match(t, /Lazer/);
    assert.match(t, /ESTOUROU em R\$ 20,00/);
    assert.match(t, /nov\/26: R\$ 500,00/);
    assert.match(t, /1 gasto\(s\) ainda não pago/);
});

test('nomes dos lançamentos só vão se o usuário marcar', () => {
    const sem = IA.montarContexto(D, { fim: '2026-10', qtd: 3, descricoes: false, orcamentos: [] });
    assert.ok(!sem.includes('Netflix Secreta') && !sem.includes('Remédio Particular'));
    const com = IA.montarContexto(D, { fim: '2026-10', qtd: 3, descricoes: true, orcamentos: [] });
    assert.ok(com.includes('Netflix Secreta'));
});
