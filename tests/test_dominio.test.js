// Testa as regras de negócio do script.js SEM alterar o arquivo:
// ele é carregado num ambiente simulado (sem navegador).
// Rodar com:  node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function criarAmbiente(fetchSimulado) {
    const eventos = [];
    const sandbox = {
        console: { log() {}, error() {}, warn() {} },
        setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
        fetch: fetchSimulado || (async () => ({ ok: true, status: 200, json: async () => [], clone() { return this; } })),
        document: {
            addEventListener(tipo, fn) { (sandbox._teclas = sandbox._teclas || []).push([tipo, fn]); },
            getElementById: () => null, querySelector: () => null,
            querySelectorAll: () => [], createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} },
        },
        navigator: { userAgent: 'teste' },
        confirm: () => true,
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = () => {};
    vm.createContext(sandbox);
    const codigo = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'script.js'), 'utf-8');
    vm.runInContext(codigo, sandbox);
    sandbox.exec = (c) => vm.runInContext(c, sandbox);
    return sandbox;
}

// ---------------- Mês da fatura ----------------
test('compra antes do dia de fechamento fica na fatura do mesmo mês', () => {
    const a = criarAmbiente();
    a.exec(`db_cartoes = [{id:'c1', nome:'XP', vencimento:'10', fechamento:'3'}]`);
    assert.strictEqual(a.exec(`calcularMesFatura(new Date(2026,6,2,12), 'c1')`), '2026-07');
});

test('compra NO dia do fechamento já entra na fatura seguinte (regra do projeto)', () => {
    const a = criarAmbiente();
    a.exec(`db_cartoes = [{id:'c1', nome:'XP', vencimento:'10', fechamento:'3'}]`);
    assert.strictEqual(a.exec(`calcularMesFatura(new Date(2026,6,3,12), 'c1')`), '2026-08');
});

test('compra depois do fechamento entra na fatura seguinte', () => {
    const a = criarAmbiente();
    a.exec(`db_cartoes = [{id:'c1', nome:'XP', vencimento:'10', fechamento:'3'}]`);
    assert.strictEqual(a.exec(`calcularMesFatura(new Date(2026,6,25,12), 'c1')`), '2026-08');
});

test('virada de ano: compra em dezembro após o fechamento vai para janeiro', () => {
    const a = criarAmbiente();
    a.exec(`db_cartoes = [{id:'c1', nome:'XP', vencimento:'10', fechamento:'3'}]`);
    assert.strictEqual(a.exec(`calcularMesFatura(new Date(2026,11,31,12), 'c1')`), '2027-01');
});

test('cartão sem fechamento cadastrado: sempre mês seguinte (comportamento antigo)', () => {
    const a = criarAmbiente();
    a.exec(`db_cartoes = [{id:'c1', nome:'Velho', vencimento:'10', fechamento:''}]`);
    assert.strictEqual(a.exec(`calcularMesFatura(new Date(2026,6,2,12), 'c1')`), '2026-08');
});

test('somarMesesAMesFatura atravessa o ano', () => {
    const a = criarAmbiente();
    assert.strictEqual(a.exec(`somarMesesAMesFatura('2026-11', 3)`), '2027-02');
    assert.strictEqual(a.exec(`somarMesesAMesFatura('2026-01', 0)`), '2026-01');
    assert.strictEqual(a.exec(`somarMesesAMesFatura('2026-12', 12)`), '2027-12');
});

// ---------------- Formatação e orçamento ----------------
test('formatarMoeda no padrão brasileiro', () => {
    const a = criarAmbiente();
    const txt = a.exec(`formatarMoeda(1234.5)`).replace(/\s/g, ' ');
    assert.ok(txt.includes('1.234,50'), txt);
    assert.ok(a.exec(`formatarMoeda('abc')`).includes('0,00'));
});

test('cor do orçamento: verde, amarelo (>=80%) e vermelho (>=100%)', () => {
    const a = criarAmbiente();
    assert.strictEqual(a.exec(`corOrcamento(50)`), 'var(--success)');
    assert.strictEqual(a.exec(`corOrcamento(80)`), 'var(--warning)');
    assert.strictEqual(a.exec(`corOrcamento(99.9)`), 'var(--warning)');
    assert.strictEqual(a.exec(`corOrcamento(100)`), 'var(--over, var(--danger))');
});

test('getOrcamento diferencia categoria, subcategoria e mês', () => {
    const a = criarAmbiente();
    a.exec(`db_orcamentos = [
        {cat_id:'c1', subcat_id:'', mes:'2026-10', valor:500},
        {cat_id:'c1', subcat_id:'s1', mes:'2026-10', valor:200},
        {cat_id:'c1', subcat_id:'', mes:'2026-11', valor:700}]`);
    assert.strictEqual(a.exec(`getOrcamento('c1','2026-10')`), 500);
    assert.strictEqual(a.exec(`getOrcamento('c1','2026-10','s1')`), 200);
    assert.strictEqual(a.exec(`getOrcamento('c1','2026-11')`), 700);
    assert.strictEqual(a.exec(`getOrcamento('c1','2026-12')`), 0);
});

// ---------------- Divisão por pessoa ----------------
test('gasto da categoria considera só a parte da pessoa principal (pontuais + faturas)', () => {
    const a = criarAmbiente();
    a.exec(`
      db_pessoas = [{id:'p_principal', nome:'Eu', tipo:'principal'}, {id:'p2', nome:'Outro', tipo:'secundaria'}];
      db_gastos_pontuais = [
        {id:'g1', cat_id:'c1', mes_ref:'2026-10', divisao:[{pessoa_id:'p_principal', valor:30},{pessoa_id:'p2', valor:70}]},
        {id:'g2', cat_id:'c1', mes_ref:'2026-09', divisao:[{pessoa_id:'p_principal', valor:999}]},
        {id:'g3', cat_id:'c2', mes_ref:'2026-10', divisao:[{pessoa_id:'p_principal', valor:999}]}];
      db_faturas = [
        {id:'f1', cat_id:'c1', mes_fatura:'2026-10', divisao:[{pessoa_id:'p_principal', valor:20},{pessoa_id:'p2', valor:5}]},
        {id:'f2', cat_id:'c1', mes_fatura:'2026-10', divisao:[{pessoa_id:'p2', valor:50}]}];
    `);
    assert.strictEqual(a.exec(`gastoCategoriaMes('c1','2026-10')`), 50);
});

// ---------------- Trava no navegador (interceptador de fetch) ----------------
test('409 + usuário confirma: reenvia com o cabeçalho de confirmação', async () => {
    const chamadas = [];
    const fetchSim = async (url, opts) => {
        chamadas.push({ url, headers: (opts && opts.headers) || {} });
        const confirmado = opts && opts.headers && opts.headers['X-Confirmar-Reducao'] === '1';
        return confirmado
            ? { ok: true, status: 200 }
            : { ok: false, status: 409, clone() { return this; }, json: async () => ({ erro: 'reducao_drastica', tabela: 'faturas', antes: 20, depois: 2 }) };
    };
    const a = criarAmbiente(fetchSim);
    a.confirm = () => true;
    const r = await a.fetch('/api/faturas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(chamadas.length, 2);
    assert.strictEqual(chamadas[1].headers['X-Confirmar-Reducao'], '1');
});

test('409 + usuário cancela: não reenvia e recarrega o estado do servidor', async () => {
    const chamadas = [];
    const fetchSim = async (url, opts) => {
        chamadas.push((opts && opts.method ? opts.method : 'GET') + ' ' + url);
        if (opts && opts.method === 'POST') {
            return { ok: false, status: 409, clone() { return this; }, json: async () => ({ erro: 'reducao_drastica', tabela: 'faturas', antes: 20, depois: 2 }) };
        }
        return { ok: true, status: 200, json: async () => [] };
    };
    const a = criarAmbiente(fetchSim);
    a.confirm = () => false;
    a.document.getElementById = () => null;
    a.exec(`renderizarApp = function() { globalThis.__redesenhou = true; }`);
    await a.fetch('/api/faturas', { method: 'POST', headers: {}, body: '[]' });
    const posts = chamadas.filter((c) => c === 'POST /api/faturas').length;
    assert.ok(a.__redesenhou, 'deveria redesenhar a tela com o estado real do servidor');
    assert.strictEqual(posts, 1, 'não pode reenviar a gravação depois de cancelar');
    assert.ok(chamadas.includes('GET /api/faturas'), 'deveria recarregar as faturas do servidor');
});

test('gravações levam a versão dos dados e ficam em fila (cada uma com a versão mais recente)', async () => {
    const enviados = [];
    let versaoServidor = 10;
    const fetchSim = async (url, opts) => {
        if (url === '/api/versao') return { ok: true, status: 200, json: async () => ({ versao: String(versaoServidor) }) };
        if (opts && opts.method === 'POST') {
            enviados.push(opts.headers['X-Versao']);
            versaoServidor++;
            return { ok: true, status: 200, headers: { get: (n) => (n === 'X-Versao' ? String(versaoServidor) : null) } };
        }
        return { ok: true, status: 200, json: async () => [] };
    };
    const a = criarAmbiente(fetchSim);
    await a.exec('carregarTabelas()');
    // duas gravações disparadas juntas (como "excluir só este mês", que grava regra e gasto)
    await Promise.all([a.fetch('/api/regras_gastos_fixos', { method: 'POST', headers: {}, body: '[]' }),
                       a.fetch('/api/gastos_pontuais', { method: 'POST', headers: {}, body: '[]' })]);
    assert.deepStrictEqual(enviados, ['10', '11'], 'a 2ª gravação precisa usar a versão devolvida pela 1ª');
});

test('409 "desatualizado": não reenvia, recarrega os dados e avisa', async () => {
    const chamadas = [];
    const fetchSim = async (url, opts) => {
        chamadas.push((opts && opts.method ? opts.method : 'GET') + ' ' + url);
        if (opts && opts.method === 'POST') return { ok: false, status: 409, clone() { return this; }, json: async () => ({ erro: 'desatualizado' }) };
        return { ok: true, status: 200, json: async () => [] };
    };
    const a = criarAmbiente(fetchSim);
    a.document.getElementById = () => null;
    a.exec(`renderizarApp = function() { globalThis.__redesenhou = true; }; globalThis.__avisos = []; mostrarAviso = function(t) { globalThis.__avisos.push(t); }; window.mostrarAviso = mostrarAviso;`);
    await a.fetch('/api/faturas', { method: 'POST', headers: {}, body: '[]' });
    assert.strictEqual(chamadas.filter((c) => c === 'POST /api/faturas').length, 1);
    assert.ok(a.__redesenhou && chamadas.includes('GET /api/faturas'));
    assert.ok(a.__avisos.some((t) => /dados novos/.test(t)));
});

test('leituras (GET) passam direto, sem interferência', async () => {
    let n = 0;
    const a = criarAmbiente(async () => { n++; return { ok: true, status: 200 }; });
    await a.fetch('/api/faturas');
    assert.strictEqual(n, 1);
});


// ---------------- Desfazer / Refazer (Fase 1) ----------------
function tecla(a, evento) {
    const h = (a._teclas || []).filter((t) => t[0] === 'keydown').map((t) => t[1]);
    let prevenido = false;
    const e = Object.assign({ ctrlKey: true, shiftKey: false, preventDefault() { prevenido = true; } }, evento);
    h.forEach((fn) => fn(e));
    return prevenido;
}

function ambienteHistorico(respostaHistorico) {
    const chamadas = [];
    const sim = async (url, opts) => {
        chamadas.push((opts && opts.method ? opts.method : 'GET') + ' ' + url);
        if (url.indexOf('/api/historico') === 0 && opts && opts.method === 'POST') {
            return { ok: true, status: 200, json: async () => respostaHistorico || { ok: true, descricao: 'Netflix' } };
        }
        if (url === '/api/historico') {
            return { ok: true, status: 200, json: async () => ({ pode_desfazer: true, desc_desfazer: 'X', pode_refazer: false }) };
        }
        return { ok: true, status: 200, json: async () => [] };
    };
    const a = criarAmbiente(sim);
    a.exec(`renderizarApp = function() {}`);
    return { a, chamadas };
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

test('Ctrl+Z chama o desfazer do servidor e recarrega os dados', async () => {
    const { a, chamadas } = ambienteHistorico();
    assert.strictEqual(tecla(a, { key: 'z' }), true);
    await espera(30);
    assert.ok(chamadas.includes('POST /api/historico/desfazer'));
    assert.ok(chamadas.includes('GET /api/gastos_pontuais'), 'deve recarregar do servidor depois de desfazer');
});

test('Ctrl+Y e Ctrl+Shift+Z chamam o refazer', async () => {
    for (const evento of [{ key: 'y' }, { key: 'Z', shiftKey: true }]) {
        const { a, chamadas } = ambienteHistorico();
        tecla(a, evento);
        await espera(30);
        assert.ok(chamadas.includes('POST /api/historico/refazer'), JSON.stringify(evento));
        assert.ok(!chamadas.includes('POST /api/historico/desfazer'));
    }
});

test('dentro de um campo de texto, Ctrl+Z não é interceptado', async () => {
    const { a, chamadas } = ambienteHistorico();
    a.document.activeElement = { tagName: 'INPUT' };
    assert.strictEqual(tecla(a, { key: 'z' }), false);
    await espera(20);
    assert.ok(!chamadas.some((c) => c.indexOf('POST /api/historico') === 0));
});

test('sem ação anterior: mostra aviso e não recarrega nada', async () => {
    const { a, chamadas } = ambienteHistorico({ ok: false, motivo: 'nada_para_desfazer' });
    tecla(a, { key: 'z' });
    await espera(30);
    assert.ok(!chamadas.includes('GET /api/gastos_pontuais'));
});

test('duas teclas seguidas não disparam dois desfazer ao mesmo tempo', async () => {
    const { a, chamadas } = ambienteHistorico();
    tecla(a, { key: 'z' });
    tecla(a, { key: 'z' });
    await espera(40);
    assert.strictEqual(chamadas.filter((c) => c === 'POST /api/historico/desfazer').length, 1);
});

test('após gravar, os botões consultam o histórico', async () => {
    const { a, chamadas } = ambienteHistorico();
    await a.fetch('/api/gastos_pontuais', { method: 'POST', headers: {}, body: '[]' });
    await espera(250);
    assert.ok(chamadas.includes('GET /api/historico'));
});
