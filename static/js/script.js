// ============================================================
// PROTEÇÃO DE GRAVAÇÃO (Fase 0)
// Todas as gravações passam por aqui. Se o servidor recusar uma gravação
// que reduziria muitos registros (HTTP 409), perguntamos ao usuário.
// Se ele não confirmar, o app recarrega o estado real do servidor, para
// que a tela nunca fique diferente do que está salvo.
// Falhas de gravação (erro 500, servidor fora do ar) também são avisadas.
// ============================================================
(function() {
    const fetchOriginal = window.fetch.bind(window);
    const NOMES_TABELAS = {
        regras_fixas: 'regras de entrada', transacoes: 'entradas', cartoes: 'cartões',
        pessoas: 'pessoas', categorias: 'categorias', subcategorias: 'subcategorias',
        faturas: 'lançamentos de cartão', gastos_pontuais: 'gastos', regras_gastos_fixos: 'gastos fixos',
        pagamentos_fatura: 'controles de fatura', orcamentos: 'orçamentos', pagamentos_pessoas: 'controles de recebimento',
        meses_fechados: 'meses fechados'
    };

    let _timerBotoes = null;
    let _fila = Promise.resolve();      // gravações saem uma de cada vez (cada uma com a versão mais recente)
    window._gravandoAgora = 0;
    window._versaoDados = null;

    window.fetch = function(url, opts) {
        const ehGravacao = typeof url === 'string' && url.indexOf('/api/') === 0 &&
                           opts && opts.method && opts.method.toUpperCase() === 'POST';
        if (!ehGravacao) return fetchOriginal(url, opts);
        window._gravandoAgora++;
        const p = _fila.then(async function() {
            try {
                const resultado = await executarFetch(url, opts);
                if (url.indexOf('/api/historico') !== 0 && resultado && resultado.ok) {
                    clearTimeout(_timerBotoes);
                    _timerBotoes = setTimeout(function() {
                        if (window.atualizarBotoesHistorico) window.atualizarBotoesHistorico();
                    }, 150);
                }
                return resultado;
            } finally { window._gravandoAgora--; }
        });
        _fila = p.catch(function() {});
        return p;
    };

    async function executarFetch(url, opts) {
        const ehGravacao = typeof url === 'string' && url.indexOf('/api/') === 0 &&
                           opts && opts.method && opts.method.toUpperCase() === 'POST';
        if (!ehGravacao) return fetchOriginal(url, opts);

        // Informa ao servidor qual versão dos dados esta tela conhece (veja "versão dos dados" no app.py)
        if (window._versaoDados !== null) {
            opts = Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { 'X-Versao': String(window._versaoDados) }) });
        }
        let resposta;
        try {
            resposta = await fetchOriginal(url, opts);
        } catch (e) {
            console.error('Servidor inacessível ao gravar ' + url, e);
            if (window.mostrarAviso) window.mostrarAviso('Não foi possível salvar: servidor inacessível', 'erro');
            throw e;
        }

        const versaoNova = resposta.headers && resposta.headers.get('X-Versao');
        if (versaoNova && resposta.status !== 409) window._versaoDados = versaoNova;

        if (resposta.status === 409) {
            let info = {};
            try { info = await resposta.clone().json(); } catch (e) {}
            if (info.erro === 'desatualizado') {
                // Outra origem (ex.: Telegram) gravou depois que esta tela carregou. Nada foi alterado.
                if (window.recarregarDoServidor) await window.recarregarDoServidor();
                if (window.mostrarAviso) window.mostrarAviso('Chegaram dados novos enquanto você editava. A tela foi atualizada: confira e repita a ação.', 'info');
                return resposta;
            }
            if (info.erro === 'reducao_drastica') {
                const nome = NOMES_TABELAS[info.tabela] || info.tabela;
                const ok = window.confirm(
                    'ATENÇÃO: esta alteração reduziria ' + nome + ' de ' + info.antes + ' para ' + info.depois + ' registros.\n\n' +
                    'Se isso foi intencional, clique em OK. Caso contrário, cancele: nada será alterado ' +
                    '(um backup de segurança já foi guardado).');
                if (ok) {
                    const novasOpts = Object.assign({}, opts, {
                        headers: Object.assign({}, opts.headers, { 'X-Confirmar-Reducao': '1' })
                    });
                    return fetchOriginal(url, novasOpts);
                }
                if (window.recarregarDoServidor) await window.recarregarDoServidor();
                if (window.mostrarAviso) window.mostrarAviso('Alteração cancelada. Nada foi apagado.', 'info');
                return resposta;
            }
        }
        if (!resposta.ok) {
            console.error('Falha ao gravar ' + url + ' (HTTP ' + resposta.status + ')');
            if (window.mostrarAviso) window.mostrarAviso('Erro ao salvar (código ' + resposta.status + ')', 'erro');
        }
        return resposta;
    }
})();

// ============================================================
// SISTEMA DE DIAGNÓSTICO — captura de erros para suporte
// ============================================================
window._logErros = [];

window.addEventListener('error', function(e) {
    window._logErros.push({
        tipo: 'Erro',
        msg: e.message,
        origem: (e.filename || '').split('/').pop() + ':' + e.lineno,
        hora: new Date().toLocaleTimeString('pt-BR')
    });
    if (window._logErros.length > 50) window._logErros.shift(); // mantém só os últimos 50
});

window.addEventListener('unhandledrejection', function(e) {
    window._logErros.push({
        tipo: 'Promessa',
        msg: (e.reason && e.reason.message) ? e.reason.message : String(e.reason),
        origem: 'async',
        hora: new Date().toLocaleTimeString('pt-BR')
    });
    if (window._logErros.length > 50) window._logErros.shift();
});

// Também captura console.error
(function() {
    const origErr = console.error;
    console.error = function() {
        const msg = Array.from(arguments).map(function(a) {
            return (a && a.message) ? a.message : String(a);
        }).join(' ');
        window._logErros.push({ tipo: 'Console', msg: msg, origem: '', hora: new Date().toLocaleTimeString('pt-BR') });
        if (window._logErros.length > 50) window._logErros.shift();
        origErr.apply(console, arguments);
    };
})();

// Inicia no mês atual, mas nunca antes de Abril/2026
let dataAtual = (function() {
    const hoje = new Date();
    const limiteMin = new Date(2026, 3, 1); // Abril/2026
    return hoje > limiteMin ? new Date(hoje.getFullYear(), hoje.getMonth(), 1) : limiteMin;
})();
let db = { regras_fixas: [], transacoes: [] };
let db_cartoes = []; 
let db_pessoas = [];
let db_categorias = []; 
let db_faturas = [];
let db_gastos_pontuais = [];
let db_regras_gastos_fixos = [];

// ============================================================
// DESFAZER / REFAZER (Fase 1)
// O histórico fica no servidor: cada ação guarda só o que mudou.
// Aqui ficam apenas os botões, os atalhos e a atualização da tela.
// (salvarSnapshotUndo existe só para não quebrar chamadas antigas e não faz nada.)
// ============================================================
function salvarSnapshotUndo() { /* substituído pelo histórico do servidor */ }

// Aviso genérico (sucesso / info / erro)
function mostrarAviso(texto, tipo) {
    const cores = { erro: 'color-mix(in srgb, var(--danger) 95%, transparent)', info: 'rgba(110,110,120,0.95)', ok: 'color-mix(in srgb, var(--success) 95%, transparent)' };
    let toast = document.getElementById('undo-toast');
    if (toast) toast.remove();
    toast = document.createElement('div');
    toast.id = 'undo-toast';
    toast.textContent = texto;
    toast.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);' +
        'background:' + (cores[tipo] || cores.info) + ';' +
        'color:#fff;padding:12px 24px;border-radius:12px;font-size:14px;font-weight:700;' +
        'z-index:99999;box-shadow:0 8px 32px rgba(0,0,0,0.4);animation:undoToastIn 0.2s ease;';
    document.body.appendChild(toast);
    setTimeout(function() { if (toast) { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; } }, 2800);
    setTimeout(function() { if (toast) toast.remove(); }, 3300);
}
window.mostrarAviso = mostrarAviso;

let _histOcupado = false;

// Atualiza os botões (ativado/desativado e o texto "Desfazer: ...")
async function atualizarBotoesHistorico() {
    try {
        const r = await fetch('/api/historico');
        const d = await r.json();
        const bd = document.getElementById('btnDesfazer');
        const br = document.getElementById('btnRefazer');
        if (bd) {
            bd.disabled = !d.pode_desfazer;
            bd.title = d.pode_desfazer ? 'Desfazer: ' + d.desc_desfazer + '  (Ctrl+Z)' : 'Nada para desfazer';
        }
        if (br) {
            br.disabled = !d.pode_refazer;
            br.title = d.pode_refazer ? 'Refazer: ' + d.desc_refazer + '  (Ctrl+Y)' : 'Nada para refazer';
        }
    } catch (e) { /* sem histórico disponível: botões ficam como estão */ }
}
window.atualizarBotoesHistorico = atualizarBotoesHistorico;

async function _executarHistorico(acao) {
    if (_histOcupado) return;
    _histOcupado = true;
    try {
        const r = await fetch('/api/historico/' + acao, { method: 'POST' });
        const d = await r.json();
        if (!d.ok) {
            mostrarAviso(acao === 'desfazer' ? 'Não há nada para desfazer' : 'Não há nada para refazer', 'info');
        } else {
            await recarregarDoServidor();
            mostrarAviso((acao === 'desfazer' ? 'Desfeito: ' : 'Refeito: ') + d.descricao, 'ok');
        }
    } catch (e) {
        console.error('Erro no ' + acao, e);
        mostrarAviso('Não foi possível ' + acao + ' agora', 'erro');
    }
    _histOcupado = false;
    atualizarBotoesHistorico();
}
function desfazer() { return _executarHistorico('desfazer'); }
function refazer()  { return _executarHistorico('refazer'); }

// Atalhos: Ctrl+Z desfaz; Ctrl+Y ou Ctrl+Shift+Z refaz.
// Dentro de campos de texto, o navegador continua desfazendo a digitação.
document.addEventListener('keydown', function(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = (e.key || '').toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    const ativo = document.activeElement;
    const tag = (ativo && ativo.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ativo && ativo.isContentEditable)) return;
    e.preventDefault();
    if (k === 'y' || (k === 'z' && e.shiftKey)) refazer(); else desfazer();
});


let db_pagamentos_fatura  = []; // { cartao_id, mes, pago }
let db_pagamentos_pessoas = [];
let db_orcamentos = []; // { cat_id, mes, valor } // { pessoa_id, mes, recebido }
let db_meses_fechados = []; // { mes, fechado_em, entradas, gastos, resumo }
let painelAberto = null;
let filtroFaturaPessoa = {};
let pagamentosStatus = {}; // { id: true/false } — controle de pagamentos do dashboard // { cartao_id: pessoa_id } — null = sem filtro
let faturaColapsada = {};    // { cartao_id: true } — true = lista oculta

// Inicialização

window.onload = async function() { await carregarDados(); };

async function carregarDados() {
    await carregarTabelas();
    renderizarApp();
    abrirPainel('dashboard');
    atualizarBotoesHistorico();
}

// Recarrega tudo do servidor e redesenha a tela, mantendo o painel atual aberto
async function recarregarDoServidor() {
    await carregarTabelas();
    renderizarApp();
    // Painéis laterais que têm listas/formulários próprios
    if (painelAberto === 'orcamento' && typeof orcInicializarForm === 'function') orcInicializarForm();
    if (painelAberto === 'entradas' && typeof entRenderizarRegras === 'function') entRenderizarRegras();
    if (painelAberto === 'configs') {
        if (typeof renderizarListaCartoes === 'function') { try { renderizarListaCartoes(); } catch (e) {} }
        if (typeof renderizarListaPessoas === 'function') { try { renderizarListaPessoas(); } catch (e) {} }
        if (typeof renderizarListaCategorias === 'function') { try { renderizarListaCategorias(); } catch (e) {} }
    }
    atualizarBotoesHistorico();
}
window.recarregarDoServidor = recarregarDoServidor;

// A cada poucos segundos confere se outra origem (ex.: bot do Telegram) gravou algo; se sim, atualiza a tela.
// Não atualiza enquanto você digita, com janela aberta, ou com uma gravação em andamento.
let _atualizandoSozinho = false;
function _usuarioOcupado() {
    const a = document.activeElement, tag = a && a.tagName;
    if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && a.id !== 'buscaGlobal') return true;
    return !!document.querySelector('.modal-overlay.active, .imp-overlay.active, #modal-excluir-fixo');
}
setInterval(async function() {
    if (_atualizandoSozinho || window._gravandoAgora || window._versaoDados === null || _usuarioOcupado()) return;
    _atualizandoSozinho = true;
    try {
        const r = await fetch('/api/versao');
        const d = await r.json();
        if (String(d.versao) !== String(window._versaoDados) && !window._gravandoAgora) {
            await recarregarDoServidor();
            mostrarAviso('Tela atualizada: chegou um lançamento novo.', 'info');
        }
    } catch (e) { /* servidor ocupado: tenta de novo no próximo ciclo */ }
    _atualizandoSozinho = false;
}, 5000);

async function carregarTabelas() {
    try {
        // A versão é lida ANTES dos dados: se algo gravar durante a leitura, a próxima gravação será recusada e a tela recarrega.
        try { const rv = await fetch('/api/versao'); window._versaoDados = (await rv.json()).versao; } catch (e) {}
        const resEnt = await fetch('/api/entradas'); db = await resEnt.json();
        const resCard = await fetch('/api/cartoes'); db_cartoes = await resCard.json();
        const resPessoas = await fetch('/api/pessoas'); db_pessoas = await resPessoas.json();
        const resCat = await fetch('/api/categorias'); db_categorias = await resCat.json();
        const resFat = await fetch('/api/faturas'); db_faturas = await resFat.json();
        const resGP = await fetch('/api/gastos_pontuais'); db_gastos_pontuais = await resGP.json();
        const resRGF = await fetch('/api/regras_gastos_fixos'); db_regras_gastos_fixos = await resRGF.json();
        const resPF  = await fetch('/api/pagamentos_fatura');  db_pagamentos_fatura  = await resPF.json();
        const resPP  = await fetch('/api/pagamentos_pessoas'); db_pagamentos_pessoas = await resPP.json();
        const resOrc = await fetch('/api/orcamentos');         db_orcamentos         = await resOrc.json();
        const resMF  = await fetch('/api/meses_fechados');     db_meses_fechados     = await resMF.json();
    } catch (e) { console.error("Erro ao carregar dados:", e); }
}

// Sincronização
async function sincronizar() { await fetch('/api/entradas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db) }); renderizarApp(); }
async function sincronizarCartoes() { await fetch('/api/cartoes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_cartoes) }); renderizarApp(); }
async function sincronizarPessoas() { await fetch('/api/pessoas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_pessoas) }); renderizarListaPessoas(); }
async function sincronizarCategorias() { await fetch('/api/categorias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_categorias) }); renderizarListaCategorias(); }
async function sincronizarFaturas() { await fetch('/api/faturas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_faturas) }); renderizarApp(); }
async function sincronizarGastosPontuais() { await fetch('/api/gastos_pontuais', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_gastos_pontuais) }); renderizarApp(); }
async function sincronizarOrcamentos() {
    await fetch('/api/orcamentos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_orcamentos) });
    if (painelAberto === 'orcamento') renderizarAreaOrcamento();
    if (painelAberto === 'dashboard') renderizarDashboard();
    if (painelAberto === 'orcamento') renderizarAreaOrcamento();
}

async function sincronizarPagamentosPessoas() {
    await fetch("/api/pagamentos_pessoas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(db_pagamentos_pessoas) });
    if (painelAberto === "dashboard") renderizarDashboard();
}

async function sincronizarPagamentosFatura() {
    await fetch('/api/pagamentos_fatura', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_pagamentos_fatura) });
    if (painelAberto === 'dashboard') renderizarDashboard();
}

async function sincronizarMesesFechados() { await fetch('/api/meses_fechados', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_meses_fechados) }); }
async function sincronizarRegrasGastosFixos() { await fetch('/api/regras_gastos_fixos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(db_regras_gastos_fixos) }); renderizarApp(); }

function formatarMoeda(v) { return (Number(v)||0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

// ============================================================
// CÁLCULO DO MÊS DA FATURA — baseado no dia de fechamento fixo do cartão
// ============================================================
// Regra: se o dia da compra for MAIOR OU IGUAL ao dia de fechamento do
// cartão, a compra entra na fatura do mês SEGUINTE. Caso contrário, entra
// na fatura do mesmo mês da compra.
// Exemplo: fechamento dia 3, compra em 03/07 → dia(3) >= fechamento(3) →
// fatura de agosto (que cobre o período 03/07 a 03/08).
// Se o cartão não tiver dia de fechamento cadastrado, mantém o comportamento
// padrão antigo (sempre mês seguinte), para não quebrar cartões já existentes.
function calcularMesFatura(dataCompra, cartaoId) {
    const cartao = db_cartoes.find(function(c) { return c.id === cartaoId; });
    const fechamentoDia = cartao && cartao.fechamento ? parseInt(cartao.fechamento) : null;

    let mes = dataCompra.getMonth();
    let ano = dataCompra.getFullYear();

    if (fechamentoDia && !isNaN(fechamentoDia)) {
        const dia = dataCompra.getDate();
        if (dia >= fechamentoDia) mes += 1;
    } else {
        mes += 1; // sem fechamento configurado: comportamento padrão (mês seguinte)
    }

    if (mes > 11) { mes = 0; ano += 1; }
    return ano + '-' + String(mes + 1).padStart(2, '0');
}

// Soma N meses a uma string "YYYY-MM" (usado para gerar as parcelas seguintes)
function somarMesesAMesFatura(mesFaturaStr, qtdMeses) {
    const partes = mesFaturaStr.split('-');
    const d = new Date(parseInt(partes[0]), parseInt(partes[1]) - 1 + qtdMeses, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function mudarMes(offset) {
    const novaData = new Date(dataAtual.getFullYear(), dataAtual.getMonth() + offset, 1);
    const limiteMin = new Date(2026, 3, 1);
    if (novaData < limiteMin) return;
    dataAtual = novaData;
    renderizarApp();
    // Garante que o painel visível é re-renderizado com o novo mês
    const dashArea = document.getElementById('area-exibicao-dashboard');
    if (dashArea && !dashArea.classList.contains('hidden')) {
        renderizarDashboard();
    }
    const orcArea = document.getElementById('area-exibicao-orcamento');
    if (orcArea && !orcArea.classList.contains('hidden')) {
        renderizarAreaOrcamento();
    }
    if (painelAberto === 'relatorios' && window.Relatorios) Relatorios.renderizar();
}

// ==== CONTROLE DOS PAINÉIS LATERAIS ====
function abrirPainel(idPainel) {
    const sidebar = document.getElementById('rightSidebar');
    const areaEntradas = document.getElementById('area-exibicao-entradas');
    const areaFaturas = document.getElementById('area-exibicao-faturas');
    const areaPontuais = document.getElementById('area-exibicao-pontuais');
    
    if (painelAberto === idPainel) { fecharPainel(); return; }
    painelAberto = idPainel; 
    
    document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('active'));
    const btnTopo = document.getElementById('btnToggle' + idPainel.charAt(0).toUpperCase() + idPainel.slice(1));
    if (btnTopo) btnTopo.classList.add('active');
    
    // Paineis puramente na área principal (sem sidebar)
    const paineisPrincipais = ['faturas', 'dashboard', 'relatorios']; // orcamento, fixos e pontuais abrem sidebar
    // Gastos Fixos e Pontuais abrem sidebar (formulário) + área principal (lista)
    if (idPainel === 'fixos' || idPainel === 'pontuais' || idPainel === 'orcamento' || idPainel === 'entradas') {
        sidebar.classList.add('active');
    } else if (paineisPrincipais.includes(idPainel)) {
        sidebar.classList.remove('active');
    } else {
        sidebar.classList.add('active');
    }
    
    const vEnt  = document.getElementById('view-entradas');  if (vEnt)  vEnt.classList.toggle('hidden', idPainel !== 'entradas');
    const vOrc  = document.getElementById('view-orcamento'); if (vOrc)  vOrc.classList.toggle('hidden', idPainel !== 'orcamento');
    const vPont = document.getElementById('view-pontuais');  if (vPont) vPont.classList.toggle('hidden', idPainel !== 'pontuais');
    const vFix  = document.getElementById('view-fixos');     if (vFix)  vFix.classList.toggle('hidden', idPainel !== 'fixos');
    const areaFixos = document.getElementById('area-exibicao-fixos');
    if (areaFixos) areaFixos.classList.toggle('hidden', idPainel !== 'fixos');
    const vCfg  = document.getElementById('view-configs');   if (vCfg)  vCfg.classList.toggle('hidden', idPainel !== 'configs');
    
    const vcc = document.getElementById('view-config-cartoes');   if (vcc) vcc.classList.add('hidden');
    const vce = document.getElementById('view-config-extrato');   if (vce) vce.classList.add('hidden');
    const vcd = document.getElementById('view-config-diagnostico'); if (vcd) vcd.classList.add('hidden');
    const vca = document.getElementById('view-config-aparencia'); if (vca) vca.classList.add('hidden');
    const vct = document.getElementById('view-config-telegram'); if (vct) vct.classList.add('hidden');
    // view-config-entradas removido
    const vcp = document.getElementById('view-config-pessoas');    if (vcp) vcp.classList.add('hidden');
    const vcat = document.getElementById('view-config-categorias'); if (vcat) vcat.classList.add('hidden');
    const vgf  = document.getElementById('view-config-gastos-fixos');  if (vgf)  vgf.classList.add('hidden');

    if (areaEntradas) areaEntradas.classList.toggle('hidden', idPainel !== 'entradas');
    if (areaFaturas) areaFaturas.classList.toggle('hidden', idPainel !== 'faturas');
    if (areaPontuais) areaPontuais.classList.toggle('hidden', idPainel !== 'pontuais');
    const areaOrc = document.getElementById('area-exibicao-orcamento');
    if (areaOrc) areaOrc.classList.toggle('hidden', idPainel !== 'orcamento');
    const areaDash = document.getElementById('area-exibicao-dashboard');
    if (areaDash) areaDash.classList.toggle('hidden', idPainel !== 'dashboard');
    const areaRel = document.getElementById('area-exibicao-relatorios');
    if (areaRel) areaRel.classList.toggle('hidden', idPainel !== 'relatorios');
    if (idPainel === 'relatorios' && window.Relatorios) Relatorios.renderizar();
    if (idPainel === 'dashboard') renderizarDashboard();
    if (idPainel === 'pontuais')  gpInicializarForm();
    if (idPainel === 'entradas')  entInicializarForm();
    if (idPainel === 'orcamento') { orcInicializarForm(); renderizarAreaOrcamento(); }
    if (idPainel === 'fixos') preencherFormularioFixos();
}

function fecharPainel() { 
    painelAberto = null; 
    document.getElementById('rightSidebar').classList.remove('active'); 
    document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('active'));
    document.getElementById('area-exibicao-entradas').classList.add('hidden');
    document.getElementById('area-exibicao-faturas').classList.add('hidden');
    const areaPontuais = document.getElementById('area-exibicao-pontuais');
    if (areaPontuais) areaPontuais.classList.add('hidden');
    const areaFixos = document.getElementById('area-exibicao-fixos');
    if (areaFixos) areaFixos.classList.add('hidden');
    const vent = document.getElementById('view-entradas');
    if (vent) vent.classList.add('hidden');
    const vorc  = document.getElementById('view-orcamento');
    if (vorc) vorc.classList.add('hidden');
    const areaOrcFech = document.getElementById('area-exibicao-orcamento');
    if (areaOrcFech) areaOrcFech.classList.add('hidden');
    const vpont = document.getElementById('view-pontuais');
    if (vpont) vpont.classList.add('hidden');
    const areaDashFech = document.getElementById('area-exibicao-dashboard');
    if (areaDashFech) areaDashFech.classList.add('hidden');
    const areaRelFech = document.getElementById('area-exibicao-relatorios');
    if (areaRelFech) areaRelFech.classList.add('hidden');
}


// ==== DASHBOARD MENSAL ====

// ── Helpers de pagamento ────────────────────────────────────

function isPagoGasto(id) {
    const g = db_gastos_pontuais.find(function(x) { return x.id === id; });
    return g ? !!g.pago : false;
}

function isPagoFatura(cartaoId, mes) {
    const p = db_pagamentos_fatura.find(function(x) { return x.cartao_id === cartaoId && x.mes === mes; });
    return p ? !!p.pago : false;
}

function togglePagoGasto(id) {
    const g = db_gastos_pontuais.find(function(x) { return x.id === id; });
    if (!g) return;
    g.pago = !g.pago;
    sincronizarGastosPontuais();
}

function marcarTodosFixos(mesAnoAtual, valor) {
    db_gastos_pontuais.forEach(function(g) {
        if (g.origem_regra && g.mes_ref === mesAnoAtual) g.pago = valor;
    });
    sincronizarGastosPontuais();
}

function togglePagoFatura(cartaoId, mes) {
    const idx = db_pagamentos_fatura.findIndex(function(x) { return x.cartao_id === cartaoId && x.mes === mes; });
    if (idx >= 0) {
        db_pagamentos_fatura[idx].pago = !db_pagamentos_fatura[idx].pago;
    } else {
        db_pagamentos_fatura.push({ cartao_id: cartaoId, mes: mes, pago: true });
    }
    sincronizarPagamentosFatura();
}

// ── Helpers de devedores ────────────────────────────────────

function isRecebidoPessoa(pessoaId, mes) {
    const p = db_pagamentos_pessoas.find(function(x) { return x.pessoa_id === pessoaId && x.mes === mes; });
    return p ? !!p.recebido : false;
}

function toggleRecebidoPessoa(pessoaId, mes) {
    const idx = db_pagamentos_pessoas.findIndex(function(x) { return x.pessoa_id === pessoaId && x.mes === mes; });
    if (idx >= 0) {
        db_pagamentos_pessoas[idx].recebido = !db_pagamentos_pessoas[idx].recebido;
    } else {
        db_pagamentos_pessoas.push({ pessoa_id: pessoaId, mes: mes, recebido: true });
    }
    sincronizarPagamentosPessoas();
}

// ── Painel de devedores (o que cada pessoa me deve no mes) ───

function renderizarPainelDevedores(mesAnoAtual, meses) {
    const principal   = db_pessoas.find(function(p) { return p.tipo === 'principal'; });
    const idPrincipal = principal ? principal.id : 'p_principal';
    const nomeMes     = meses[dataAtual.getMonth()];

    const mapa = {};
    function somar(pessoaId, valor, tipo, desc) {
        if (!mapa[pessoaId]) mapa[pessoaId] = { fixos: 0, pontuais: 0, cartao: 0, total: 0, detalhes: [] };
        mapa[pessoaId][tipo]  += valor;
        mapa[pessoaId].total  += valor;
        mapa[pessoaId].detalhes.push({ tipo: tipo, desc: desc, valor: valor });
    }

    // Gastos fixos
    db_gastos_pontuais.filter(function(g) { return g.origem_regra && g.mes_ref === mesAnoAtual; })
        .forEach(function(g) {
            g.divisao.filter(function(d) { return d.pessoa_id !== idPrincipal && d.valor > 0; })
                .forEach(function(d) { somar(d.pessoa_id, d.valor, 'fixos', g.desc); });
        });

    // Gastos pontuais
    db_gastos_pontuais.filter(function(g) { return !g.origem_regra && g.mes_ref === mesAnoAtual; })
        .forEach(function(g) {
            g.divisao.filter(function(d) { return d.pessoa_id !== idPrincipal && d.valor > 0; })
                .forEach(function(d) { somar(d.pessoa_id, d.valor, 'pontuais', g.desc); });
        });

    // Faturas de cartao
    db_faturas.filter(function(f) { return f.mes_fatura === mesAnoAtual; })
        .forEach(function(f) {
            const cartao = db_cartoes.find(function(c) { return c.id === f.cartao_id; });
            f.divisao.filter(function(d) { return d.pessoa_id !== idPrincipal && d.valor > 0; })
                .forEach(function(d) {
                    somar(d.pessoa_id, d.valor, 'cartao', f.desc + (cartao ? ' (' + cartao.nome + ')' : ''));
                });
        });

    const devedores = Object.keys(mapa).filter(function(pId) { return mapa[pId].total > 0; });

    if (devedores.length === 0) {
        return '<div style="background:var(--w-03);border:1px solid var(--w-08);' +
               'border-radius:16px;padding:20px;margin-top:14px;">' +
               '<div style="font-size:11px;font-weight:700;color:var(--primary);' +
               'letter-spacing:0.8px;margin-bottom:10px;"><svg class="ic ic-t"><use href="#i-users"/></svg>A Receber de Terceiros &mdash; ' + nomeMes + '</div>' +
               '<p style="font-size:12px;color:var(--text-muted);">Ningu&eacute;m deve nada este m&ecirc;s.</p></div>';
    }

    const totalRecebido = devedores.filter(function(pId) { return isRecebidoPessoa(pId, mesAnoAtual); })
        .reduce(function(s, pId) { return s + mapa[pId].total; }, 0);
    const totalPendente = devedores.filter(function(pId) { return !isRecebidoPessoa(pId, mesAnoAtual); })
        .reduce(function(s, pId) { return s + mapa[pId].total; }, 0);

    const pessoasHtml = devedores.map(function(pId) {
        const pessoa   = db_pessoas.find(function(x) { return x.id === pId; });
        const nome     = pessoa ? pessoa.nome : '?';
        const d        = mapa[pId];
        const recebido = isRecebidoPessoa(pId, mesAnoAtual);
        const icones   = [
            d.fixos    > 0 ? '<svg class="ic"><use href="#i-fixos"/></svg>' : '',
            d.pontuais > 0 ? '<svg class="ic"><use href="#i-pontual"/></svg>' : '',
            d.cartao   > 0 ? '<svg class="ic"><use href="#i-cartao"/></svg>' : ''
        ].filter(Boolean).join(' ');


        const cor    = recebido ? 'color-mix(in srgb, var(--success) 5%, transparent)' : 'var(--w-03)';
        const borda  = recebido ? 'color-mix(in srgb, var(--success) 18%, transparent)'  : 'rgba(255,255,255,0.07)';
        const corVal = recebido ? 'var(--success)' : 'var(--info)';
        const corNome = recebido ? 'var(--text-muted)' : 'var(--text-main)';
        const strike  = recebido ? 'text-decoration:line-through;' : '';
        const checkBg = recebido ? 'var(--success)' : 'transparent';
        const checkBd = recebido ? 'var(--success)' : 'var(--w-25)';
        const checkMark = recebido ? '<span style="color:#000;font-size:12px;font-weight:900;"><svg class="ic"><use href="#i-check"/></svg></span>' : '';

        return '<div style="background:' + cor + ';border:1px solid ' + borda + ';' +
               'border-radius:12px;padding:13px;margin-bottom:9px;transition:all 0.2s;">' +
               '<div style="display:flex;align-items:center;gap:10px;">' +
               '<div onclick="toggleRecebidoPessoa(\'' + pId + '\',\'' + mesAnoAtual + '\')" ' +
               'style="width:22px;height:22px;border-radius:50%;flex-shrink:0;cursor:pointer;' +
               'border:2px solid ' + checkBd + ';background:' + checkBg + ';' +
               'display:flex;align-items:center;justify-content:center;transition:all 0.2s;">' +
               checkMark + '</div>' +
               '<div style="flex:1;">' +
               '<div style="font-size:13px;font-weight:700;color:' + corNome + ';' + strike + '">' + nome + '</div>' +
               '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">' + icones + '</div></div>' +
               '<span style="font-size:15px;font-weight:800;color:' + corVal + ';">' + formatarMoeda(d.total) + '</span></div>' +
               '</div>';
    }).join('');

    return '<div style="background:var(--w-03);border:1px solid var(--w-08);' +
           'border-radius:16px;padding:20px;margin-top:14px;' +
           'box-shadow:0 4px 20px rgba(0,0,0,0.2),inset 0 1px 0 var(--w-06);">' +
           '<div style="font-size:11px;font-weight:700;color:var(--primary);' +
           'letter-spacing:0.8px;margin-bottom:14px;"><svg class="ic ic-t"><use href="#i-users"/></svg>A Receber de Terceiros &mdash; ' + nomeMes + '</div>' +
           '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">' +
           '<div style="background:color-mix(in srgb, var(--success) 8%, transparent);border:1px solid color-mix(in srgb, var(--success) 20%, transparent);border-radius:10px;padding:10px;text-align:center;">' +
           '<div style="font-size:9px;color:var(--text-muted);letter-spacing:0.5px;">Recebido</div>' +
           '<div style="font-size:15px;font-weight:800;color:var(--success);">' + formatarMoeda(totalRecebido) + '</div></div>' +
           '<div style="background:color-mix(in srgb, var(--accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--accent) 20%, transparent);border-radius:10px;padding:10px;text-align:center;">' +
           '<div style="font-size:9px;color:var(--text-muted);letter-spacing:0.5px;">Pendente</div>' +
           '<div style="font-size:15px;font-weight:800;color:var(--info);">' + formatarMoeda(totalPendente) + '</div></div></div>' +
           pessoasHtml + '</div>';
}

// ── Painel de controle de pagamentos (lado direito) ─────────

// ── Painel de confirmação de pagamento dos gastos pontuais ──

function renderizarPainelPontuaisPagamento(mesAnoAtual, meses) {
    const principal   = db_pessoas.find(function(p) { return p.tipo === 'principal'; });
    const idPrincipal = principal ? principal.id : 'p_principal';
    const nomeMes     = meses[dataAtual.getMonth()];

    function minhaParte(divisao) {
        const d = divisao.find(function(x) { return x.pessoa_id === idPrincipal; });
        return d ? d.valor : 0;
    }

    const pontuaisMes = db_gastos_pontuais.filter(function(g) {
        return !g.origem_regra && g.mes_ref === mesAnoAtual &&
               g.divisao.some(function(d) { return d.pessoa_id === idPrincipal; });
    });

    if (pontuaisMes.length === 0) {
        return '<div style="background:var(--w-03);border:1px solid var(--w-08);' +
               'border-radius:16px;padding:20px;margin-top:14px;">' +
               '<div style="font-size:12px;font-weight:700;color:var(--primary);' +
               'letter-spacing:0.8px;margin-bottom:10px;"><svg class="ic ic-t"><use href="#i-pontual"/></svg>Gastos Pontuais &mdash; ' + nomeMes + '</div>' +
               '<p style="font-size:12px;color:var(--text-muted);">Nenhum gasto pontual neste m&ecirc;s.</p></div>';
    }

    const totalPago    = pontuaisMes.filter(function(g){ return g.pago; }).reduce(function(s,g){ return s + minhaParte(g.divisao); }, 0);
    const totalPendente = pontuaisMes.filter(function(g){ return !g.pago; }).reduce(function(s,g){ return s + minhaParte(g.divisao); }, 0);

    const itensHtml = pontuaisMes.map(function(g) {
        const pago     = !!g.pago;
        const cat      = db_categorias.find(function(c){ return c.id === g.cat_id; });
        const meuVal   = minhaParte(g.divisao);
        const tagParc  = g.total_parcelas > 1
            ? '<span style="font-size:9px;color:var(--info);font-weight:700;margin-right:4px;">' + g.parcela_num + '/' + g.total_parcelas + '</span>'
            : '';
        const checkBg  = pago ? 'var(--success)' : 'transparent';
        const checkBd  = pago ? 'var(--success)' : 'var(--w-25)';
        const checkMark = pago ? '<span style="color:#000;font-size:10px;font-weight:900;"><svg class="ic"><use href="#i-check"/></svg></span>' : '';
        const corNome  = pago ? 'var(--text-muted)' : 'var(--text-main)';
        const strike   = pago ? 'text-decoration:line-through;' : '';
        const corVal   = pago ? 'var(--success)' : 'var(--danger)';

        return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--w-05);">' +
               '<div onclick="togglePagoGasto(\'' + g.id + '\')"' +
               'style="width:18px;height:18px;border-radius:4px;flex-shrink:0;cursor:pointer;' +
               'border:2px solid ' + checkBd + ';background:' + checkBg + ';' +
               'display:flex;align-items:center;justify-content:center;transition:all 0.2s;">' +
               checkMark + '</div>' +
               '<div style="flex:1;min-width:0;">' +
               '<div style="font-size:12px;font-weight:600;color:' + corNome + ';' + strike + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
               tagParc + g.desc + '</div>' +
               '<div style="font-size:10px;color:var(--text-muted);">' + (cat ? cat.nome : 'Sem cat') + '</div></div>' +
               '<span style="font-size:12px;font-weight:700;color:' + corVal + ';flex-shrink:0;">' + formatarMoeda(meuVal) + '</span>' +
               '</div>';
    }).join('');

    return '<div style="background:var(--w-03);border:1px solid var(--w-08);' +
           'border-radius:16px;padding:20px;margin-top:14px;' +
           'box-shadow:0 4px 20px rgba(0,0,0,0.2),inset 0 1px 0 var(--w-06);">' +
           '<div style="font-size:12px;font-weight:700;color:var(--primary);' +
           'letter-spacing:0.8px;margin-bottom:14px;"><svg class="ic ic-t"><use href="#i-pontual"/></svg>Gastos Pontuais &mdash; ' + nomeMes + '</div>' +
           '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">' +
           '<div style="background:color-mix(in srgb, var(--success) 8%, transparent);border:1px solid color-mix(in srgb, var(--success) 20%, transparent);border-radius:10px;padding:10px;text-align:center;">' +
           '<div style="font-size:9px;color:var(--text-muted);letter-spacing:0.5px;">Pago</div>' +
           '<div style="font-size:15px;font-weight:800;color:var(--success);">' + formatarMoeda(totalPago) + '</div></div>' +
           '<div style="background:color-mix(in srgb, var(--danger) 8%, transparent);border:1px solid color-mix(in srgb, var(--danger) 20%, transparent);border-radius:10px;padding:10px;text-align:center;">' +
           '<div style="font-size:9px;color:var(--text-muted);letter-spacing:0.5px;">Pendente</div>' +
           '<div style="font-size:15px;font-weight:800;color:var(--danger);">' + formatarMoeda(totalPendente) + '</div></div></div>' +
           itensHtml + '</div>';
}


function renderizarPainelPagamentos(mesAnoAtual, meses) {
    const principal = db_pessoas.find(function(p) { return p.tipo === 'principal'; });
    const idPrincipal = principal ? principal.id : 'p_principal';
    const nomeMes = meses[dataAtual.getMonth()];

    function minhaParte(divisao) {
        const d = divisao.find(function(x) { return x.pessoa_id === idPrincipal; });
        return d ? d.valor : 0;
    }

    // ── Fixos ───────────────────────────────────────────────
    const fixosMes = db_gastos_pontuais.filter(function(g) {
        return g.origem_regra && g.mes_ref === mesAnoAtual &&
               g.divisao.some(function(d) { return d.pessoa_id === idPrincipal; });
    });
    const todosFixosPagos = fixosMes.length > 0 && fixosMes.every(function(g) { return g.pago; });

    const fixosHtml = fixosMes.map(function(g) {
        const pago = !!g.pago;
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;' +
               'border-bottom:1px solid var(--w-05);">' +
               '<div onclick="togglePagoGasto(\'' + g.id + '\')" style="width:20px;height:20px;border-radius:50%;' +
               'border:2px solid ' + (pago ? 'var(--success)' : 'var(--w-25)') + ';' +
               'background:' + (pago ? 'var(--success)' : 'transparent') + ';' +
               'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.2s;">' +
               (pago ? '<span style="color:#000;font-size:11px;font-weight:900;"><svg class="ic"><use href="#i-check"/></svg></span>' : '') +
               '</div>' +
               '<span style="flex:1;font-size:12px;color:' + (pago ? 'var(--text-muted)' : 'var(--text-main)') + ';' +
               (pago ? 'text-decoration:line-through;' : '') + '">' + g.desc + '</span>' +
               '<span style="font-size:12px;font-weight:700;color:' + (pago ? 'var(--success)' : 'var(--danger)') + ';">' +
               formatarMoeda(minhaParte(g.divisao)) + '</span>' +
               '</div>';
    }).join('');

    // Fixos pagos no cartão: aparecem aqui só para você enxergar; o pagamento é o da fatura e o valor já está em "Faturas de Cartão"
    const fixosCartaoMes = db_faturas.filter(function(f) {
        return f.fixo && f.mes_fatura === mesAnoAtual && minhaParte(f.divisao) !== 0;
    }).sort(function(a, b) { return (a.data_compra || '').localeCompare(b.data_compra || ''); });
    const fixosCartaoHtml = fixosCartaoMes.map(function(f) {
        const cartao = db_cartoes.find(function(c) { return c.id === f.cartao_id; });
        const pagoCartao = isPagoFatura(f.cartao_id, mesAnoAtual);
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--w-05);" ' +
               'title="Pago junto com a fatura do cartão (já somado em Faturas de Cartão)">' +
               '<div style="width:20px;height:20px;border-radius:50%;border:2px ' + (pagoCartao ? 'solid var(--success)' : 'dashed var(--w-25)') + ';' +
               'background:' + (pagoCartao ? 'var(--success)' : 'transparent') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
               (pagoCartao ? '<span style="color:#000;font-size:11px;font-weight:900;"><svg class="ic"><use href="#i-check"/></svg></span>' : '') + '</div>' +
               '<span style="flex:1;font-size:12px;color:' + (pagoCartao ? 'var(--text-muted)' : 'var(--text-main)') + ';' + (pagoCartao ? 'text-decoration:line-through;' : '') + '">' +
               f.desc + ' <span style="font-size:10px;color:var(--info);"><svg class="ic ic-t"><use href="#i-cartao"/></svg>' + (cartao ? cartao.nome : 'cartão') + '</span></span>' +
               '<span style="font-size:12px;font-weight:700;color:' + (pagoCartao ? 'var(--success)' : 'var(--danger)') + ';">' + formatarMoeda(minhaParte(f.divisao)) + '</span></div>';
    }).join('');
    const fixosListaHtml = (fixosHtml || fixosCartaoHtml)
        ? fixosHtml + fixosCartaoHtml +
          (fixosCartaoHtml ? '<p style="font-size:10px;color:var(--text-muted);margin:6px 0 0;"><svg class="ic ic-t"><use href="#i-cartao"/></svg>Os fixos do cartão já estão somados na fatura abaixo; aqui não entram de novo nos totais.</p>' : '')
        : '<p style="font-size:11px;color:var(--text-muted);padding:8px 0;">Sem gastos fixos.</p>';

    const totalFixosPago    = fixosMes.filter(function(g){ return g.pago; }).reduce(function(s,g){ return s + minhaParte(g.divisao); }, 0);
    const totalFixosPendente = fixosMes.filter(function(g){ return !g.pago; }).reduce(function(s,g){ return s + minhaParte(g.divisao); }, 0);

    // ── Pontuais ────────────────────────────────────────────
    const pontuaisMes = db_gastos_pontuais.filter(function(g) {
        return !g.origem_regra && g.mes_ref === mesAnoAtual &&
               g.divisao.some(function(d) { return d.pessoa_id === idPrincipal; });
    });

    const pontuaisHtml = pontuaisMes.map(function(g) {
        const pago = !!g.pago;
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;' +
               'border-bottom:1px solid var(--w-05);">' +
               '<div onclick="togglePagoGasto(\'' + g.id + '\')" style="width:20px;height:20px;border-radius:6px;' +
               'border:2px solid ' + (pago ? 'var(--success)' : 'var(--w-25)') + ';' +
               'background:' + (pago ? 'var(--success)' : 'transparent') + ';' +
               'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.2s;">' +
               (pago ? '<span style="color:#000;font-size:11px;font-weight:900;"><svg class="ic"><use href="#i-check"/></svg></span>' : '') +
               '</div>' +
               '<span style="flex:1;font-size:12px;color:' + (pago ? 'var(--text-muted)' : 'var(--text-main)') + ';' +
               (pago ? 'text-decoration:line-through;' : '') + '">' + g.desc + '</span>' +
               '<span style="font-size:12px;font-weight:700;color:' + (pago ? 'var(--success)' : 'var(--danger)') + ';">' +
               formatarMoeda(minhaParte(g.divisao)) + '</span>' +
               '</div>';
    }).join('') || '<p style="font-size:11px;color:var(--text-muted);padding:8px 0;">Sem gastos pontuais.</p>';

    const totalPontuaisPago    = pontuaisMes.filter(function(g){ return g.pago; }).reduce(function(s,g){ return s + minhaParte(g.divisao); }, 0);
    const totalPontuaisPendente = pontuaisMes.filter(function(g){ return !g.pago; }).reduce(function(s,g){ return s + minhaParte(g.divisao); }, 0);

    // ── Cartões ─────────────────────────────────────────────
    const cartoesHtml = db_cartoes.map(function(c) {
        const faturas = db_faturas.filter(function(f) { return f.cartao_id === c.id && f.mes_fatura === mesAnoAtual; });
        if (faturas.length === 0) return '';
        const totalMinha = faturas.reduce(function(s,f){ return s + minhaParte(f.divisao); }, 0);
        const pago = isPagoFatura(c.id, mesAnoAtual);
        return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;' +
               'border-bottom:1px solid var(--w-05);">' +
               '<div onclick="togglePagoFatura(\'' + c.id + '\',\'' + mesAnoAtual + '\')" ' +
               'style="width:20px;height:20px;border-radius:50%;' +
               'border:2px solid ' + (pago ? 'var(--success)' : 'var(--w-25)') + ';' +
               'background:' + (pago ? 'var(--success)' : 'transparent') + ';' +
               'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;' +
               'transition:all 0.2s;border-left:3px solid ' + c.cor + ';">' +
               (pago ? '<span style="color:#000;font-size:11px;font-weight:900;"><svg class="ic"><use href="#i-check"/></svg></span>' : '') +
               '</div>' +
               '<div style="flex:1;">' +
               '<div style="font-size:12px;color:' + (pago ? 'var(--text-muted)' : 'var(--text-main)') + ';font-weight:600;">' + c.nome + '</div>' +
               '<div style="font-size:10px;color:var(--text-muted);">' + faturas.length + ' lançamento' + (faturas.length > 1 ? 's' : '') + '</div>' +
               '</div>' +
               '<span style="font-size:13px;font-weight:700;color:' + (pago ? 'var(--success)' : 'var(--danger)') + ';">' +
               formatarMoeda(totalMinha) + '</span>' +
               '</div>';
    }).join('') || '<p style="font-size:11px;color:var(--text-muted);padding:8px 0;">Sem faturas.</p>';

    const cartoesComFatura = db_cartoes.filter(function(c) {
        return db_faturas.some(function(f){ return f.cartao_id === c.id && f.mes_fatura === mesAnoAtual; });
    });
    const totalCartoesPago    = cartoesComFatura.filter(function(c){ return isPagoFatura(c.id, mesAnoAtual); })
        .reduce(function(s,c){ return s + db_faturas.filter(function(f){ return f.cartao_id === c.id && f.mes_fatura === mesAnoAtual; }).reduce(function(ss,f){ return ss + minhaParte(f.divisao); },0); }, 0);
    const totalCartoesPendente = cartoesComFatura.filter(function(c){ return !isPagoFatura(c.id, mesAnoAtual); })
        .reduce(function(s,c){ return s + db_faturas.filter(function(f){ return f.cartao_id === c.id && f.mes_fatura === mesAnoAtual; }).reduce(function(ss,f){ return ss + minhaParte(f.divisao); },0); }, 0);

    const totalPago    = totalFixosPago    + totalPontuaisPago    + totalCartoesPago;
    const totalPendente = totalFixosPendente + totalPontuaisPendente + totalCartoesPendente;

    return '<div style="background:var(--w-03);border:1px solid var(--w-08);' +
           'border-radius:16px;padding:20px;' +
           'box-shadow:0 4px 20px rgba(0,0,0,0.2),inset 0 1px 0 var(--w-06);">' +

           // Cabeçalho
           '<div style="font-size:12px;font-weight:700;color:var(--primary);' +
           'letter-spacing:0.8px;margin-bottom:16px;"><svg class="ic ic-t"><use href="#i-cartao"/></svg>Controle de Pagamentos — ' + nomeMes + '</div>' +

           // Totais resumidos
           '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px;">' +
           '<div style="background:color-mix(in srgb, var(--success) 8%, transparent);border:1px solid color-mix(in srgb, var(--success) 20%, transparent);border-radius:10px;padding:10px;text-align:center;">' +
           '<div style="font-size:9px;color:var(--text-muted);letter-spacing:0.5px;">Pago</div>' +
           '<div style="font-size:16px;font-weight:800;color:var(--success);">' + formatarMoeda(totalPago) + '</div></div>' +
           '<div style="background:color-mix(in srgb, var(--danger) 8%, transparent);border:1px solid color-mix(in srgb, var(--danger) 20%, transparent);border-radius:10px;padding:10px;text-align:center;">' +
           '<div style="font-size:9px;color:var(--text-muted);letter-spacing:0.5px;">Pendente</div>' +
           '<div style="font-size:16px;font-weight:800;color:var(--danger);">' + formatarMoeda(totalPendente) + '</div></div>' +
           '</div>' +

           // Seção Fixos
           '<div style="margin-bottom:16px;">' +
           '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
           '<span style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;"><svg class="ic ic-t"><use href="#i-fixos"/></svg>Gastos Fixos</span>' +
           '<button onclick="marcarTodosFixos(\'' + mesAnoAtual + '\',' + (!todosFixosPagos) + ')" ' +
           'style="font-size:10px;background:var(--w-06);border:1px solid var(--w-12);' +
           'color:var(--text-muted);border-radius:6px;padding:3px 8px;cursor:pointer;">' +
           (todosFixosPagos ? 'Desmarcar todos' : 'Marcar todos') + '</button></div>' +
           fixosListaHtml + '</div>' +

           // Seção Pontuais
           '<div style="margin-bottom:16px;">' +
           '<div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;margin-bottom:8px;"><svg class="ic ic-t"><use href="#i-pontual"/></svg>Gastos Pontuais</div>' +
           pontuaisHtml + '</div>' +

           // Seção Cartões
           '<div>' +
           '<div style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;margin-bottom:8px;"><svg class="ic ic-t"><use href="#i-cartao"/></svg>Faturas de Cartão</div>' +
           cartoesHtml + '</div>' +

           '</div>';
}

function renderizarDashboard() {
    const area = document.getElementById('area-exibicao-dashboard');
    if (!area) return;
    // Garantir que a área está visível
    area.classList.remove('hidden');

    const mesAnoAtual = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const nomeMes = meses[dataAtual.getMonth()];

    const principal = db_pessoas.find(function(p) { return p.tipo === 'principal'; });
    const idPrincipal = principal ? principal.id : 'p_principal';

    function minhaParte(divisao) {
        const d = divisao.find(function(x) { return x.pessoa_id === idPrincipal; });
        return d ? d.valor : 0;
    }
    function parteOutros(divisao) {
        return divisao.filter(function(x) { return x.pessoa_id !== idPrincipal; })
                      .reduce(function(s, x) { return s + x.valor; }, 0);
    }

    const fixosMes    = db_gastos_pontuais.filter(function(g) { return g.origem_regra && g.mes_ref === mesAnoAtual; });
    const pontuaisMes = db_gastos_pontuais.filter(function(g) { return !g.origem_regra && g.mes_ref === mesAnoAtual; });
    const faturasMes  = db_faturas.filter(function(f) { return f.mes_fatura === mesAnoAtual; });
    const entradasMes = db.transacoes.filter(function(t) { return t.data && t.data.startsWith(mesAnoAtual); });

    const totalFixos    = fixosMes.reduce(function(s, g) { return s + minhaParte(g.divisao); }, 0);
    const totalPontuais = pontuaisMes.reduce(function(s, g) { return s + minhaParte(g.divisao); }, 0);
    const totalCartao   = faturasMes.reduce(function(s, f) { return s + minhaParte(f.divisao); }, 0);
    const totalEntradas = entradasMes.reduce(function(s, t) { return s + t.valor; }, 0);
    const outrosFixos   = fixosMes.reduce(function(s, g) { return s + parteOutros(g.divisao); }, 0);
    // Fixos pagos no cartão: informativo, JÁ estão dentro de totalCartao (não somar de novo)
    const fixosNoCartao = faturasMes.filter(function(f) { return f.fixo; }).reduce(function(s, f) { return s + minhaParte(f.divisao); }, 0);
    const outrosPontuais = pontuaisMes.reduce(function(s, g) { return s + parteOutros(g.divisao); }, 0);
    const outrosCartao  = faturasMes.reduce(function(s, f) { return s + parteOutros(f.divisao); }, 0);
    const outrosTotal   = outrosFixos + outrosPontuais + outrosCartao;
    const meuTotal      = totalFixos + totalPontuais + totalCartao;
    const saldo         = totalEntradas - meuTotal;

    // Mapa por categoria e subcategoria: { catNome: { total, subs: { subNome: valor } } }
    const catMap = {};
    function somarCategoria(lista, valorFn) {
        lista.forEach(function(item) {
            const cat    = db_categorias.find(function(c) { return c.id === item.cat_id; });
            const catNome = cat ? cat.nome : 'Sem categoria';
            const subcat  = cat ? cat.subcategorias.find(function(s){ return s.id === item.subcat_id; }) : null;
            const subNome = subcat ? subcat.nome : 'Outros';
            if (!catMap[catNome]) catMap[catNome] = { total: 0, subs: {} };
            catMap[catNome].total += valorFn(item);
            if (!catMap[catNome].subs[subNome]) catMap[catNome].subs[subNome] = 0;
            catMap[catNome].subs[subNome] += valorFn(item);
        });
    }
    somarCategoria(fixosMes,    function(g) { return minhaParte(g.divisao); });
    somarCategoria(pontuaisMes, function(g) { return minhaParte(g.divisao); });
    somarCategoria(faturasMes,  function(f) { return minhaParte(f.divisao); });

    const cats = Object.keys(catMap).sort(function(a, b) { return catMap[b].total - catMap[a].total; });
const catsHtml = cats.map(function(nome, idx) {
        const val     = catMap[nome].total;
        const subs    = catMap[nome].subs;
        const pct     = meuTotal > 0 ? (val / meuTotal) * 100 : 0;
        const expandida = !!_catExpandidas[nome];
        const temSubs   = Object.keys(subs).length > 1 || (Object.keys(subs).length === 1 && Object.keys(subs)[0] !== 'Outros');

        // Subcategorias (visíveis apenas quando expandida)
        const subsHtml = expandida ? Object.keys(subs).sort(function(a,b){ return subs[b]-subs[a]; }).map(function(subNome) {
            const subVal = subs[subNome];
            const subPct = val > 0 ? (subVal / val) * 100 : 0;
            return '<div style="display:flex;justify-content:space-between;align-items:center;' +
                   'padding:5px 10px;background:var(--w-03);border-radius:6px;margin-bottom:4px;">' +
                   '<span style="font-size:11px;color:var(--text-muted);">&#x2514; ' + subNome + '</span>' +
                   '<span style="font-size:11px;font-weight:600;color:var(--danger);">' + formatarMoeda(subVal) + ' <span style="color:var(--text-muted);font-weight:400;">(' + subPct.toFixed(0) + '%)</span></span>' +
                   '</div>';
        }).join('') : '';

        return '<div style="margin-bottom:14px;">' +
            '<div data-catidx="' + idx + '" data-catnome="' + nome.replace(/"/g,'&quot;') + '"' +
            ' onclick="toggleCatExpansao(' + idx + ')"' +
            ' style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;cursor:' + (temSubs ? 'pointer' : 'default') + ';">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
            (temSubs ? '<span style="font-size:10px;color:var(--text-muted);display:inline-block;transform:' + (expandida ? 'rotate(90deg)' : 'rotate(0deg)') + ';transition:transform 0.2s;"><svg class="ic"><use href="#i-chevr"/></svg></span>' : '<span style="display:inline-block;width:14px;"></span>') +
            '<span style="font-size:13px;color:var(--text-main);font-weight:500;">' + nome + '</span></div>' +
            '<span style="font-size:13px;font-weight:700;color:var(--danger);">' + formatarMoeda(val) + '</span></div>' +
            '<div style="height:4px;border-radius:4px;background:var(--w-08);overflow:hidden;margin-left:20px;">' +
            '<div style="height:100%;width:' + pct.toFixed(1) + '%;border-radius:4px;' +
            'background:var(--accent);transition:width 0.6s ease;"></div></div>' +
            '<div style="font-size:10px;color:var(--text-muted);margin-top:3px;margin-left:20px;">' + pct.toFixed(0) + '% do total</div>' +
            (expandida && subsHtml ? '<div style="margin-top:8px;margin-left:20px;">' + subsHtml + '</div>' : '') +
            '</div>';
    }).join('') || '<p style="color:var(--text-muted);font-size:12px;">Nenhum gasto registrado.</p>';

    function bloco(emoji, titulo, valor, sub, corValor) {
        return '<div style="background:var(--w-04);border:1px solid var(--w-09);' +
            'border-radius:16px;padding:18px;position:relative;overflow:hidden;' +
            'box-shadow:0 4px 20px rgba(0,0,0,0.25),inset 0 1px 0 var(--w-08);">' +
            '<div style="position:absolute;top:0;left:10%;right:10%;height:1px;' +
            'background:linear-gradient(90deg,transparent,rgba(255,255,255,0.15),transparent);"></div>' +
            '<div style="font-size:10px;color:var(--text-muted);letter-spacing:0.8px;font-weight:700;margin-bottom:6px;">' + emoji + ' ' + titulo + '</div>' +
            '<div style="font-size:22px;font-weight:700;color:' + (corValor || 'var(--danger)') + ';line-height:1.1;">' + formatarMoeda(valor) + '</div>' +
            (sub ? '<div style="font-size:10px;color:var(--text-muted);margin-top:5px;">' + sub + '</div>' : '') +
            '</div>';
    }

    // Layout: dois painéis lado a lado
    area.innerHTML =
        '<div style="margin-bottom:24px;border-bottom:1px solid var(--w-08);padding-bottom:14px;">' +
        '<h3 style="color:var(--primary);font-size:20px;margin:0;font-weight:700;"><svg class="ic ic-t"><use href="#i-dash"/></svg>Dashboard — ' + nomeMes + '</h3>' +
        '<p style="color:var(--text-muted);font-size:12px;margin-top:4px;">Visão consolidada dos seus gastos' + ((db_meses_fechados || []).some(function(x) { return x.mes === mesAnoAtual; }) ? ' &nbsp;·&nbsp; <span style="color:var(--success)"><svg class="ic ic-t"><use href="#i-lock"/></svg>mês fechado</span>' : '') + '</p></div>' +

        '<div style="display:grid;grid-template-columns:1fr 360px;gap:24px;align-items:start;">' +

        // ── PAINEL ESQUERDO (resumo) ──────────────────────────
        '<div>' +
        // Saldo
        '<div style="background:' + (saldo >= 0 ? 'color-mix(in srgb, var(--success) 10%, transparent)' : 'color-mix(in srgb, var(--danger) 10%, transparent)') + ';' +
        'border:1px solid ' + (saldo >= 0 ? 'color-mix(in srgb, var(--success) 25%, transparent)' : 'color-mix(in srgb, var(--danger) 25%, transparent)') + ';' +
        'border-radius:20px;padding:22px;margin-bottom:20px;' +
        'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px;' +
        'box-shadow:0 8px 32px rgba(0,0,0,0.2),inset 0 1px 0 var(--w-08);">' +
        '<div><div style="font-size:10px;color:var(--text-muted);letter-spacing:0.8px;font-weight:700;">SALDO DO MÊS</div>' +
        '<div style="font-size:34px;font-weight:800;color:' + (saldo >= 0 ? 'var(--success)' : 'var(--danger)') + ';line-height:1.1;margin-top:4px;">' + formatarMoeda(saldo) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:5px;">' + formatarMoeda(totalEntradas) + ' de entradas − ' + formatarMoeda(meuTotal) + ' de gastos meus</div></div>' +
        '<div style="text-align:right;"><div style="font-size:10px;color:var(--text-muted);letter-spacing:0.8px;font-weight:700;">TOTAL GERADO</div>' +
        '<div style="font-size:20px;font-weight:700;color:var(--warning);margin-top:4px;">' + formatarMoeda(meuTotal + outrosTotal) + '</div>' +
        '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">incluindo terceiros</div></div></div>' +

        // 4 blocos
        '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:22px;">' +
        bloco('<svg class="ic"><use href="#i-fixos"/></svg>', 'Gastos Fixos',      totalFixos,    [outrosFixos > 0 ? 'Terceiros: ' + formatarMoeda(outrosFixos) : null,
        fixosNoCartao !== 0 ? '+ ' + formatarMoeda(fixosNoCartao) + ' fixos no cartão (já contados em Cartão de Crédito)' : null].filter(Boolean).join('<br>') || null) +
        bloco('<svg class="ic"><use href="#i-pontual"/></svg>', 'Gastos Pontuais',   totalPontuais, outrosPontuais > 0 ? 'Terceiros: ' + formatarMoeda(outrosPontuais) : null) +
        bloco('<svg class="ic"><use href="#i-cartao"/></svg>', 'Cartão de Crédito', totalCartao,   outrosCartao > 0   ? 'Terceiros: ' + formatarMoeda(outrosCartao)   : null) +
        bloco('<svg class="ic"><use href="#i-users"/></svg>', 'A Receber',         outrosTotal,   'Total que terceiros devem', 'var(--info)') +
        '</div>' +

        // Categorias
        '<div style="background:var(--w-03);border:1px solid var(--w-08);' +
        'border-radius:16px;padding:20px;box-shadow:0 4px 20px rgba(0,0,0,0.2),inset 0 1px 0 var(--w-06);">' +
        '<div style="font-size:10px;color:var(--text-muted);letter-spacing:0.8px;font-weight:700;margin-bottom:18px;">MEUS GASTOS POR CATEGORIA</div>' +
        catsHtml + renderizarCardOrcamentoDash(mesAnoAtual) + '</div></div>' +

        // -- PAINEL DIREITO (pagamentos + devedores) --------------------
        '<div>' + renderizarPainelPagamentos(mesAnoAtual, meses) + renderizarPainelDevedores(mesAnoAtual, meses) + '</div>' +

        '</div>';
}



// ==============================================================
// MODULO DE ORCAMENTO
// ==============================================================

// Retorna o valor orcado para uma categoria num mes
let _orcDebounce = null; // timer de debounce para salvar orcamentos

// Atualiza db_orcamentos em tempo real e salva apos pausa de digitacao
function orcAtualizarTempoReal(input) {
    const mesAnoAtual = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    const catId    = input.dataset.catid;
    const subcatId = input.dataset.subcatid || '';
    const valor    = parseFloat(input.value) || 0;
    const idx = db_orcamentos.findIndex(function(o) {
        return o.cat_id === catId && (o.subcat_id || '') === subcatId && o.mes === mesAnoAtual;
    });

    if (valor > 0) {
        if (idx >= 0) db_orcamentos[idx].valor = valor;
        else db_orcamentos.push({ cat_id: catId, subcat_id: subcatId, mes: mesAnoAtual, valor: valor });
    } else if (idx >= 0) {
        db_orcamentos.splice(idx, 1);
    }

    // Atualiza a visualizacao da area imediatamente
    renderizarAreaOrcamento();

    // Salva no banco apos 600ms de pausa (evita requisicao a cada tecla)
    clearTimeout(_orcDebounce);
    _orcDebounce = setTimeout(function() {
        fetch('/api/orcamentos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(db_orcamentos)
        }).then(function() {
            if (painelAberto === 'dashboard') renderizarDashboard();
        });
    }, 600);
}

function getOrcamento(catId, mes, subcatId) {
    subcatId = subcatId || '';
    const o = db_orcamentos.find(function(x) {
        return x.cat_id === catId && (x.subcat_id || '') === subcatId && x.mes === mes;
    });
    return o ? o.valor : 0;
}

// Calcula semanas calendario (seg-dom) restantes no mes a partir de hoje
function semanasRestantesNoMes() {
    const hoje = new Date();
    const anoMes = hoje.getFullYear();
    const mes   = hoje.getMonth();
    const fimMes = new Date(anoMes, mes + 1, 0); // ultimo dia do mes

    // Coleta todos os inicios de semana (segunda-feira) de hoje ate fim do mes
    const semanas = new Set();
    const d = new Date(hoje);
    while (d <= fimMes) {
        // Inicio da semana (segunda-feira)
        const diaSemana = d.getDay(); // 0=dom,1=seg,...,6=sab
        const diasAteSeg = diaSemana === 0 ? -6 : 1 - diaSemana;
        const seg = new Date(d);
        seg.setDate(d.getDate() + diasAteSeg);
        semanas.add(seg.toISOString().slice(0, 10));
        d.setDate(d.getDate() + 1);
    }
    return Math.max(semanas.size, 1);
}

// Calcula gasto total da categoria no mes (minha parte)
function gastoCategoriaMes(catId, mesAnoAtual) {
    const principal   = db_pessoas.find(function(p) { return p.tipo === 'principal'; });
    const idPrincipal = principal ? principal.id : 'p_principal';
    function minhaParte(divisao) {
        const d = divisao.find(function(x) { return x.pessoa_id === idPrincipal; });
        return d ? d.valor : 0;
    }
    let total = 0;
    db_gastos_pontuais.filter(function(g) { return g.cat_id === catId && g.mes_ref === mesAnoAtual; })
        .forEach(function(g) { total += minhaParte(g.divisao); });
    db_faturas.filter(function(f) { return f.cat_id === catId && f.mes_fatura === mesAnoAtual; })
        .forEach(function(f) { total += minhaParte(f.divisao); });
    return total;
}

// Cor do status do orcamento
function corOrcamento(pct) {
    if (pct >= 100) return 'var(--over, var(--danger))';   // vermelho - estourou
    if (pct >= 80)  return 'var(--warning)';   // amarelo  - atencao
    return 'var(--success)';                   // verde    - ok
}

// ── Sidebar: formulario de configuracao de orcamento ────────

let _orcCatExpandidas = {}; // { catId: true } para expandir subcats no form

function orcToggleExpandirCat(catId) {
    _orcCatExpandidas[catId] = !_orcCatExpandidas[catId];
    orcInicializarForm();
    // Restaura foco no input da categoria expandida
    setTimeout(function() {
        const el = document.querySelector('.orc-input[data-catid="' + catId + '"]:not([data-subcatid])');
        if (el) el.focus();
    }, 30);
}

function orcInicializarForm() {
    const mesAnoAtual = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    const lista = document.getElementById('orc-lista-form');
    if (!lista) return;

    lista.innerHTML = db_categorias.map(function(cat) {
        const orc      = getOrcamento(cat.id, mesAnoAtual);
        const expandida = !!_orcCatExpandidas[cat.id];
        const temSubs  = cat.subcategorias && cat.subcategorias.length > 0;

        // Soma dos orçamentos de subcategorias já definidos
        const totalSubcats = cat.subcategorias
            ? cat.subcategorias.reduce(function(s, sub) { return s + getOrcamento(cat.id, mesAnoAtual, sub.id); }, 0)
            : 0;
        const alertSubcats = orc > 0 && totalSubcats > orc
            ? '<span style="font-size:9px;color:var(--danger);margin-left:4px;"><svg class="ic ic-t"><use href="#i-alert"/></svg>subcats > total</span>' : '';

        // Linhas de subcategorias
        const subsHtml = (expandida && temSubs) ? cat.subcategorias.map(function(sub) {
            const subOrc = getOrcamento(cat.id, mesAnoAtual, sub.id);
            return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0 5px 18px;border-bottom:1px solid var(--w-04);">' +
                   '<span style="font-size:10px;color:var(--text-muted);flex:1;">&#x2514; ' + sub.nome + '</span>' +
                   '<input type="number" step="10" min="0" class="input-quick orc-input" ' +
                   'data-catid="' + cat.id + '" data-subcatid="' + sub.id + '"' +
                   ' value="' + (subOrc || '') + '" placeholder="R$ 0" ' +
                   'oninput="orcAtualizarTempoReal(this)" style="width:80px;font-size:11px;"></div>';
        }).join('') : '';

        return '<div style="border-bottom:1px solid var(--w-06);">' +
               // Linha da categoria
               '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;">' +
               (temSubs
                   ? '<span onclick="orcToggleExpandirCat(\'' + cat.id + '\')"'
                     + ' style="font-size:10px;color:var(--text-muted);cursor:pointer;'
                     + 'transform:' + (expandida ? 'rotate(90deg)' : 'rotate(0deg)') + ';display:inline-block;transition:transform 0.2s;width:12px;"><svg class="ic"><use href="#i-chevr"/></svg></span>'
                   : '<span style="width:12px;display:inline-block;"></span>') +
               '<span style="flex:1;font-size:12px;color:var(--text-main);">' + cat.nome + alertSubcats + '</span>' +
               (totalSubcats > 0 && orc > 0 ? '<span style="font-size:9px;color:var(--text-muted);">subs: ' + formatarMoeda(totalSubcats) + '</span>' : '') +
               '<input type="number" step="10" min="0" class="input-quick orc-input" data-catid="' + cat.id + '"' +
               ' value="' + (orc || '') + '" placeholder="R$ 0" ' +
               'oninput="orcAtualizarTempoReal(this)" style="width:85px;"></div>' +
               subsHtml +
               '</div>';
    }).join('');
}

function orcSalvar() {
    const mesAnoAtual = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    const inputs = document.querySelectorAll('.orc-input');
    inputs.forEach(function(inp) {
        const catId = inp.dataset.catid;
        const valor = parseFloat(inp.value) || 0;
        const subcatId = inp.dataset.subcatid || '';
        const idx = db_orcamentos.findIndex(function(o) {
            return o.cat_id === catId && (o.subcat_id || '') === subcatId && o.mes === mesAnoAtual;
        });
        if (valor > 0) {
            if (idx >= 0) db_orcamentos[idx].valor = valor;
            else db_orcamentos.push({ cat_id: catId, subcat_id: subcatId, mes: mesAnoAtual, valor: valor });
        } else if (idx >= 0) {
            db_orcamentos.splice(idx, 1);
        }
    });
    sincronizarOrcamentos();
}

// ── Aba principal: visualizacao detalhada ───────────────────

function renderizarAreaOrcamento() {
    const area = document.getElementById('area-exibicao-orcamento');
    if (!area) return;

    const mesAnoAtual = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    const meses = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const nomeMes = meses[dataAtual.getMonth()];

    // So mostra orcamento do mes atual com semanas restantes
    const ehMesAtual = (mesAnoAtual === new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0'));
    const semanasRest = ehMesAtual ? semanasRestantesNoMes() : null;

    // Saldo do mes: entradas - todos os meus gastos (referencia para orcamento)
    const principal_orc = db_pessoas.find(function(p){ return p.tipo === 'principal'; });
    const idPrincipal_orc = principal_orc ? principal_orc.id : 'p_principal';
    function minhaParteOrc(divisao) {
        const d = divisao.find(function(x){ return x.pessoa_id === idPrincipal_orc; });
        return d ? d.valor : 0;
    }
    const entradasMes = db.transacoes.filter(function(t){ return t.data && t.data.startsWith(mesAnoAtual); });
    const totalEntradasMes = entradasMes.reduce(function(s,t){ return s + t.valor; }, 0);
    const totalGastoMes =
        db_gastos_pontuais.filter(function(g){ return g.mes_ref === mesAnoAtual; }).reduce(function(s,g){ return s + minhaParteOrc(g.divisao); }, 0) +
        db_faturas.filter(function(f){ return f.mes_fatura === mesAnoAtual; }).reduce(function(s,f){ return s + minhaParteOrc(f.divisao); }, 0);
    const saldoMes = totalEntradasMes - totalGastoMes;

    // Categorias com orcamento definido
    const todasCats = db_categorias.filter(function(cat) { return getOrcamento(cat.id, mesAnoAtual) > 0; });
    const catsComOrc = todasCats.filter(function(cat){ return getOrcamento(cat.id, mesAnoAtual) > 0; });

    let totalOrc = 0, totalGasto = 0;
    todasCats.forEach(function(cat) {
        totalOrc   += getOrcamento(cat.id, mesAnoAtual);
        totalGasto += gastoCategoriaMes(cat.id, mesAnoAtual);
    });
    const totalRestante = totalOrc > 0 ? totalOrc - totalGasto : saldoMes;
    const pctTotal = totalOrc > 0 ? (totalGasto / totalOrc) * 100 : 0;
    const corTotal = corOrcamento(pctTotal);

    // Cards de resumo do topo
    const temOrc = totalOrc > 0;
    const resumoHtml =
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px;">' +
        // Total orcado ou saldo
        '<div style="background:var(--w-04);border:1px solid var(--w-09);border-radius:14px;padding:18px;text-align:center;">' +
        '<div style="font-size:10px;color:var(--text-muted);letter-spacing:0.6px;margin-bottom:6px;">' + (temOrc ? 'Or&#xE7;amento Total' : 'Saldo do M&#xEA;s') + '</div>' +
        '<div style="font-size:22px;font-weight:800;color:' + (temOrc ? 'var(--primary)' : 'var(--success)') + ';">' + formatarMoeda(temOrc ? totalOrc : saldoMes) + '</div>' +
        (!temOrc ? '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Defina or&#xE7;amentos ao lado</div>' : '') +
        '</div>' +
        // Gasto
        '<div style="background:var(--w-04);border:1px solid var(--w-09);border-radius:14px;padding:18px;text-align:center;">' +
        '<div style="font-size:10px;color:var(--text-muted);letter-spacing:0.6px;margin-bottom:6px;">Gasto at&#xE9; agora</div>' +
        '<div style="font-size:22px;font-weight:800;color:' + (temOrc ? corTotal : 'var(--danger)') + ';">' + formatarMoeda(totalGasto) + '</div>' +
        (temOrc ? '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">' + pctTotal.toFixed(0) + '% do or&#xE7;amento</div>' : '') +
        '</div>' +
        // Restante / disponível
        '<div style="background:' + (totalRestante >= 0 ? 'color-mix(in srgb, var(--success) 8%, transparent)' : 'color-mix(in srgb, var(--danger) 8%, transparent)') + ';border:1px solid ' + (totalRestante >= 0 ? 'color-mix(in srgb, var(--success) 20%, transparent)' : 'color-mix(in srgb, var(--danger) 20%, transparent)') + ';border-radius:14px;padding:18px;text-align:center;">' +
        '<div style="font-size:10px;color:var(--text-muted);letter-spacing:0.6px;margin-bottom:6px;">' + (totalRestante >= 0 ? 'Dispon&#xED;vel' : 'Estourado') + '</div>' +
        '<div style="font-size:22px;font-weight:800;color:' + (totalRestante >= 0 ? 'var(--success)' : 'var(--danger)') + ';">' + formatarMoeda(Math.abs(totalRestante)) + '</div>' +
        (semanasRest && totalRestante > 0 ? '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">~' + formatarMoeda(totalRestante / semanasRest) + '/semana</div>' : '') +
        '</div></div>';

    // Lista por categoria
    const listaCatsHtml = todasCats.map(function(cat) {
        const orc      = getOrcamento(cat.id, mesAnoAtual);
        const gasto    = gastoCategoriaMes(cat.id, mesAnoAtual);
        const restante = orc - gasto;
        const pct      = orc > 0 ? Math.min((gasto / orc) * 100, 100) : 0;
        const cor      = corOrcamento(pct);
        const semStr   = (semanasRest && restante > 0) ? formatarMoeda(restante / semanasRest) + '/sem' : '';

        // Subcategorias com orcamento definido
        const subcatsComOrc = cat.subcategorias.filter(function(sub) {
            return getOrcamento(cat.id, mesAnoAtual, sub.id) > 0;
        });
        const subcatOrcHtml = subcatsComOrc.map(function(sub) {
            const subOrc   = getOrcamento(cat.id, mesAnoAtual, sub.id);
            const subGasto = (function() {
                const principal = db_pessoas.find(function(p){ return p.tipo === 'principal'; });
                const idP = principal ? principal.id : 'p_principal';
                let t = 0;
                db_gastos_pontuais.filter(function(g){ return g.cat_id === cat.id && g.subcat_id === sub.id && g.mes_ref === mesAnoAtual; })
                    .forEach(function(g){ const d = g.divisao.find(function(x){ return x.pessoa_id === idP; }); t += d ? d.valor : 0; });
                db_faturas.filter(function(f){ return f.cat_id === cat.id && f.subcat_id === sub.id && f.mes_fatura === mesAnoAtual; })
                    .forEach(function(f){ const d = f.divisao.find(function(x){ return x.pessoa_id === idP; }); t += d ? d.valor : 0; });
                return t;
            })();
            const subRest = subOrc - subGasto;
            const subPct  = subOrc > 0 ? Math.min((subGasto / subOrc) * 100, 100) : 0;
            const subCor  = corOrcamento(subPct);
            return '<div style="margin:6px 0 6px 16px;padding:8px 10px;background:var(--w-02);border-radius:8px;border-left:2px solid ' + subCor + ';">' +
                   '<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px;">' +
                   '<span style="color:var(--text-muted);">&#x2514; ' + sub.nome + '</span>' +
                   '<span style="color:' + subCor + ';font-weight:600;">' + formatarMoeda(subGasto) + ' / ' + formatarMoeda(subOrc) + '</span></div>' +
                   '<div style="height:3px;border-radius:2px;background:var(--w-08);overflow:hidden;">' +
                   '<div style="height:100%;width:' + subPct.toFixed(1) + '%;background:' + subCor + ';"></div></div>' +
                   (subRest >= 0 ? '<div style="font-size:10px;color:var(--text-muted);margin-top:3px;">Restam ' + formatarMoeda(subRest) + '</div>' : '<div style="font-size:10px;color:var(--danger);margin-top:3px;">Estourou ' + formatarMoeda(Math.abs(subRest)) + '</div>') +
                   '</div>';
        }).join('');

        // Subcategorias
        const subMap = {};
        db_gastos_pontuais.filter(function(g){ return g.cat_id === cat.id && g.mes_ref === mesAnoAtual; })
            .forEach(function(g) {
                const sub = cat.subcategorias.find(function(s){ return s.id === g.subcat_id; });
                const key = sub ? sub.nome : 'Outros';
                const principal = db_pessoas.find(function(p){ return p.tipo === 'principal'; });
                const idP = principal ? principal.id : 'p_principal';
                const d = g.divisao.find(function(x){ return x.pessoa_id === idP; });
                subMap[key] = (subMap[key] || 0) + (d ? d.valor : 0);
            });
        db_faturas.filter(function(f){ return f.cat_id === cat.id && f.mes_fatura === mesAnoAtual; })
            .forEach(function(f) {
                const sub = cat.subcategorias.find(function(s){ return s.id === f.subcat_id; });
                const key = sub ? sub.nome : 'Outros';
                const principal = db_pessoas.find(function(p){ return p.tipo === 'principal'; });
                const idP = principal ? principal.id : 'p_principal';
                const d = f.divisao.find(function(x){ return x.pessoa_id === idP; });
                subMap[key] = (subMap[key] || 0) + (d ? d.valor : 0);
            });

        const subsHtml = Object.keys(subMap).sort(function(a,b){ return subMap[b]-subMap[a]; }).map(function(subNome) {
            const sv = subMap[subNome];
            const spct = gasto > 0 ? (sv / gasto) * 100 : 0;
            return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:11px;">' +
                   '<span style="color:var(--text-muted);">&#x2514; ' + subNome + '</span>' +
                   '<span style="color:var(--text-main);">' + formatarMoeda(sv) + ' <span style="color:var(--text-muted);">(' + spct.toFixed(0) + '%)</span></span></div>';
        }).join('');

        const semOrc = orc === 0;
        return '<div style="background:' + (semOrc ? 'var(--w-02)' : 'var(--w-04)') + ';border:1px solid ' + (semOrc ? 'var(--w-06)' : 'var(--w-09)') + ';border-radius:14px;padding:16px;margin-bottom:10px;">'
            + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:' + (semOrc ? '6' : '10') + 'px;">' +
            '<div>' +
            '<div style="font-size:14px;font-weight:' + (semOrc ? '500' : '700') + ';color:' + (semOrc ? 'var(--text-muted)' : 'var(--text-main)') + ';">' + cat.nome + '</div>' +
            (!semOrc && semStr ? '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;"><svg class="ic ic-t"><use href="#i-calendar"/></svg>' + semStr + ' disponivel</div>' : '') +
            '</div>' +
            '<div style="text-align:right;">' +
            (semOrc
                ? (gasto > 0
                    ? '<div style="font-size:12px;font-weight:600;color:var(--warning);">' + formatarMoeda(gasto) + '</div><div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Sem or&#xE7;amento</div>'
                    : '<div style="font-size:12px;color:var(--text-muted);">R$ 0,00 &mdash; Sem or&#xE7;amento</div>')
                : '<div style="font-size:13px;font-weight:700;color:' + cor + ';">' + formatarMoeda(gasto) + ' <span style="color:var(--text-muted);font-weight:400;font-size:11px;">/ ' + formatarMoeda(orc) + '</span></div>' +
                  '<div style="font-size:11px;color:' + (restante >= 0 ? 'var(--success)' : 'var(--danger)') + ';margin-top:2px;">' + (restante >= 0 ? 'Restam ' : 'Estourou ') + formatarMoeda(Math.abs(restante)) + '</div>') +
            '</div></div>' +
            '<div style="height:' + (semOrc ? '3' : '8') + 'px;border-radius:4px;background:var(--w-06);overflow:hidden;margin-bottom:' + (semOrc ? '4' : '8') + 'px;">'
            + '<div style="height:100%;width:' + pct.toFixed(1) + '%;border-radius:4px;background:' + (semOrc ? 'var(--w-12)' : cor) + ';transition:width 0.5s;"></div></div>' +
            (subcatOrcHtml && !semOrc ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--w-05);"><div style="font-size:9px;color:var(--text-muted);letter-spacing:0.5px;margin-bottom:6px;">Or&#xE7;amento por subcategoria</div>' + subcatOrcHtml + '</div>' : '') +
            (subsHtml && !subcatOrcHtml && !semOrc ? '<div style="padding-top:8px;border-top:1px solid var(--w-05);">' + subsHtml + '</div>' : '') +
            '</div>';
    }).join('');

    const semOrcHtml = ''; // todas as cats agora aparecem juntas

    const semDadosHtml = todasCats.length === 0
        ? '<div style="max-width:600px;">' +
          '<div style="background:color-mix(in srgb, var(--accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--accent) 25%, transparent);border-radius:16px;padding:28px;text-align:center;margin-bottom:20px;">' +
          '<div style="font-size:36px;margin-bottom:12px;"><svg class="ic"><use href="#i-orc"/></svg></div>' +
          '<div style="font-size:15px;font-weight:700;color:var(--text-main);margin-bottom:6px;">Nenhum or&#xE7;amento definido para ' + nomeMes + '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);margin-bottom:20px;">Use o formul&#xE1;rio ao lado para distribuir seu or&#xE7;amento por categoria.</div>' +
          (totalEntradasMes > 0 ?
              '<div style="background:color-mix(in srgb, var(--success) 10%, transparent);border:1px solid color-mix(in srgb, var(--success) 25%, transparent);border-radius:12px;padding:16px;display:inline-block;min-width:200px;">' +
              '<div style="font-size:10px;color:var(--text-muted);letter-spacing:0.6px;margin-bottom:6px;">Dispon&#xED;vel para or&#xE7;ar</div>' +
              '<div style="font-size:32px;font-weight:800;color:var(--success);">&#x27;' + formatarMoeda(totalEntradasMes) + '&#x27;</div>' +
              '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Total de entradas de ' + nomeMes + '</div></div>'
          : '<div style="font-size:12px;color:var(--text-muted);">Sem entradas registradas neste m&#xEA;s.</div>')
          + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);text-align:center;">&#x2190; Defina quanto planeja gastar em cada categoria usando o formul&#xE1;rio ao lado</div></div>'
        : '';

    area.innerHTML =
        '<div style="margin-bottom:24px;border-bottom:1px solid var(--w-08);padding-bottom:14px;">' +
        '<h3 style="color:var(--primary);font-size:20px;margin:0;font-weight:700;"><svg class="ic ic-t"><use href="#i-orc"/></svg>Orcamento — ' + nomeMes + '</h3>' +
        (semanasRest ? '<p style="color:var(--text-muted);font-size:12px;margin-top:4px;">' + semanasRest + ' semana(s) calendario restantes no mes</p>' : '') + '</div>' +
        resumoHtml +
        (todasCats.length > 0 ? '<div style="max-width:700px;">' + listaCatsHtml + '</div>'
            : '<p style="color:var(--text-muted);font-size:12px;max-width:700px;padding:4px 0;">"Defina or&#xE7;amentos na barra ao lado para visualizar o controle por categoria.</p>');

}

// ── Dashboard: card resumido de orcamento ───────────────────

function renderizarCardOrcamentoDash(mesAnoAtual) {
    const catsComOrc = db_categorias.filter(function(cat) {
        return getOrcamento(cat.id, mesAnoAtual) > 0;
    });
    if (catsComOrc.length === 0) return '';

    let totalOrc = 0, totalGasto = 0;
    catsComOrc.forEach(function(cat) {
        totalOrc   += getOrcamento(cat.id, mesAnoAtual);
        totalGasto += gastoCategoriaMes(cat.id, mesAnoAtual);
    });
    const restante = totalOrc - totalGasto;
    const pct      = totalOrc > 0 ? Math.min((totalGasto / totalOrc) * 100, 100) : 0;
    const cor      = corOrcamento(pct);

    const ehMesAtual = (mesAnoAtual === new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0'));
    const semanasRest = ehMesAtual ? semanasRestantesNoMes() : null;

    // Detalhes por categoria (expansivel)
    const expandido = _dashOrcExpandido;

    const detalhesHtml = expandido ? catsComOrc.map(function(cat) {
        const orc   = getOrcamento(cat.id, mesAnoAtual);
        const gasto = gastoCategoriaMes(cat.id, mesAnoAtual);
        const p     = orc > 0 ? Math.min((gasto / orc) * 100, 100) : 0;
        const c     = corOrcamento(p);
        return '<div style="margin-bottom:10px;">' +
               '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">' +
               '<span style="color:var(--text-main);">' + cat.nome + '</span>' +
               '<span style="color:' + c + ';font-weight:600;">' + formatarMoeda(gasto) + ' / ' + formatarMoeda(orc) + '</span></div>' +
               '<div style="height:5px;border-radius:3px;background:var(--w-08);overflow:hidden;">' +
               '<div style="height:100%;width:' + p.toFixed(1) + '%;background:' + c + ';border-radius:3px;"></div></div></div>';
    }).join('') : '';

    return '<div style="background:var(--w-03);border:1px solid var(--w-09);border-radius:16px;padding:20px;margin-top:22px;">' +
           '<div onclick="toggleDashOrc()" style="cursor:pointer;">' +
           '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
           '<div style="font-size:11px;color:var(--text-muted);letter-spacing:0.7px;font-weight:700;"><svg class="ic ic-t"><use href="#i-orc"/></svg>Orcamento do Mes</div>' +
           '<span style="font-size:12px;color:var(--text-muted);display:inline-block;transition:transform 0.2s;transform:' + (expandido ? 'rotate(180deg)' : 'rotate(0deg)') + ';"><svg class="ic"><use href="#i-chevu"/></svg></span></div>' +
           '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:10px;">' +
           '<div><div style="font-size:24px;font-weight:800;color:' + cor + ';">' + formatarMoeda(totalGasto) + '</div>' +
           '<div style="font-size:11px;color:var(--text-muted);">de ' + formatarMoeda(totalOrc) + ' orcados</div></div>' +
           '<div style="text-align:right;">' +
           '<div style="font-size:14px;font-weight:700;color:' + (restante >= 0 ? 'var(--success)' : 'var(--danger)') + ';">' + (restante >= 0 ? '+' : '') + formatarMoeda(restante) + '</div>' +
           (semanasRest && restante > 0 ? '<div style="font-size:10px;color:var(--text-muted);">~' + formatarMoeda(restante / semanasRest) + '/semana</div>' : '') + '</div></div>' +
           '<div style="height:8px;border-radius:4px;background:var(--w-08);overflow:hidden;">' +
           '<div style="height:100%;width:' + pct.toFixed(1) + '%;border-radius:4px;background:' + cor + ';transition:width 0.5s;"></div></div></div>' +
           (expandido ? '<div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.07);">' + detalhesHtml + '</div>' : '') +
           '</div>';
}


// ==== MÓDULO EXTRATO ====

function abrirExtrato() {
    const vCfg = document.getElementById('view-configs');
    const vExt = document.getElementById('view-config-extrato');
    if (vCfg) vCfg.classList.add('hidden');
    if (vExt) vExt.classList.remove('hidden');
    extInicializar();
}

function voltarParaConfigs() {
    const vCfg = document.getElementById('view-configs');
    const vExt = document.getElementById('view-config-extrato');
    if (vExt) vExt.classList.add('hidden');
    const vDiag = document.getElementById('view-config-diagnostico');
    if (vDiag) vDiag.classList.add('hidden');
    if (vCfg) vCfg.classList.remove('hidden');
}

function extInicializar() {
    const mesesNome = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // Pessoas — exceto principal, ou todas
    const divP = document.getElementById('ext-pessoas');
    if (divP) {
        divP.innerHTML = db_pessoas.map(function(p) {
            return '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-main);cursor:pointer;padding:4px 0;">' +
                   '<input type="checkbox" class="ext-check-pessoa" data-id="' + p.id + '" style="width:15px;height:15px;cursor:pointer;accent-color:var(--info);" checked>' +
                   p.nome + (p.tipo === 'principal' ? ' (Eu)' : '') + '</label>';
        }).join('');
    }

    // Últimos 6 meses
    const divM = document.getElementById('ext-meses');
    if (divM) {
        divM.innerHTML = '';
        for (let i = 5; i >= 0; i--) {
            const d = new Date(dataAtual.getFullYear(), dataAtual.getMonth() - i, 1);
            const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
            const label = mesesNome[d.getMonth()] + ' ' + d.getFullYear();
            const btn = document.createElement('button');
            btn.dataset.mes = key;
            btn.textContent = label;
            btn.className = 'ext-mes-btn';
            const ativo = i === 0; // mês atual selecionado por padrão
            btn.style.cssText = 'padding:5px 10px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;transition:all 0.15s;' +
                'background:' + (ativo ? 'var(--accent)' : 'var(--w-06)') + ';' +
                'border:1px solid ' + (ativo ? 'var(--accent)' : 'var(--w-12)') + ';' +
                'color:' + (ativo ? 'var(--on-accent)' : 'var(--text-muted)') + ';';
            btn.setAttribute('data-ativo', ativo ? '1' : '0');
            btn.addEventListener('click', function() {
                const isAtivo = this.getAttribute('data-ativo') === '1';
                this.setAttribute('data-ativo', isAtivo ? '0' : '1');
                this.style.background = isAtivo ? 'var(--w-06)' : 'var(--accent)';
                this.style.borderColor = isAtivo ? 'var(--w-12)' : 'var(--accent)';
                this.style.color = isAtivo ? 'var(--text-muted)' : 'var(--on-accent)';
            });
            divM.appendChild(btn);
        }
    }
}

function gerarExtrato() {
    const pessoasSel = Array.from(document.querySelectorAll('.ext-check-pessoa:checked')).map(function(c) { return c.dataset.id; });
    const mesesSel   = Array.from(document.querySelectorAll('.ext-mes-btn[data-ativo="1"]')).map(function(b) { return b.dataset.mes; }).sort();
    const detalhar   = document.getElementById('ext-detalhar').checked;

    if (pessoasSel.length === 0) { alert('Selecione pelo menos uma pessoa!'); return; }
    if (mesesSel.length === 0)   { alert('Selecione pelo menos um mês!'); return; }

    const mesesNome = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                       'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // ── Montar dados ──────────────────────────────────────
    const blocos = [];
    pessoasSel.forEach(function(pessoaId) {
        const pessoa = db_pessoas.find(function(p) { return p.id === pessoaId; });
        if (!pessoa) return;
        let totalGeral = 0;
        const mesesData = mesesSel.map(function(mes) {
            const mesArr = mes.split('-');
            const nomeMes = mesesNome[parseInt(mesArr[1])-1] + ' de ' + mesArr[0];
            const catMap = {};
            function addItem(catNome, desc, valor) {
                if (!catMap[catNome]) catMap[catNome] = { total: 0, itens: [] };
                catMap[catNome].total += valor;
                catMap[catNome].itens.push({ desc: desc, valor: valor });
            }
            db_gastos_pontuais.filter(function(g) { return g.mes_ref === mes; }).forEach(function(g) {
                const div = g.divisao.find(function(d) { return d.pessoa_id === pessoaId; });
                if (!div || div.valor <= 0) return;
                const cat = db_categorias.find(function(c) { return c.id === g.cat_id; });
                addItem(cat ? cat.nome : 'Sem categoria', g.desc, div.valor);
            });
            db_faturas.filter(function(f) { return f.mes_fatura === mes; }).forEach(function(f) {
                const div = f.divisao.find(function(d) { return d.pessoa_id === pessoaId; });
                if (!div || div.valor <= 0) return;
                const cartao = db_cartoes.find(function(c) { return c.id === f.cartao_id; });
                const cn = 'Cartao ' + (cartao ? cartao.nome : '');
                const tag = f.total_parcelas > 1 ? ' (' + f.parcela_atual + '/' + f.total_parcelas + ')' : '';
                addItem(cn, f.desc + tag, div.valor);
            });
            const totalMes = Object.values(catMap).reduce(function(s, c) { return s + c.total; }, 0);
            totalGeral += totalMes;
            return { nomeMes: nomeMes, catMap: catMap, totalMes: totalMes };
        });
        blocos.push({ pessoaNome: pessoa.nome + (pessoa.tipo === 'principal' ? ' (Eu)' : ''), mesesData: mesesData, totalGeral: totalGeral });
    });

    // ── Configurações visuais ────────────────────────────
    const W     = 800;
    const PAD   = 48;   // padding horizontal
    const INNER = W - PAD * 2;
    const SCALE = 2;

    // Alturas fixas por tipo de linha
    const H = {
        HEADER:    90,   // cabeçalho do doc
        PESSOA:    52,   // bloco da pessoa
        MES:       38,   // bloco do mês
        CAT:       28,   // linha de categoria
        ITEM:      20,   // linha de item
        TOTAL_MES: 36,   // linha de total do mês
        TOTAL_GER: 44,   // total geral
        GAP_MES:   20,   // espaço entre meses
        GAP_PESSOA:32,   // espaço entre pessoas
        FOOTER:    48,   // rodapé
    };

    // Calcular altura total
    let alturaTotal = H.HEADER;
    blocos.forEach(function(bloco) {
        alturaTotal += H.PESSOA;
        bloco.mesesData.forEach(function(m, mi) {
            alturaTotal += H.MES;
            const cats = Object.keys(m.catMap);
            if (cats.length === 0) {
                alturaTotal += H.ITEM + 12;
            } else {
                cats.forEach(function(cn) {
                    alturaTotal += H.CAT;
                    if (detalhar) alturaTotal += m.catMap[cn].itens.length * H.ITEM;
                });
            }
            alturaTotal += H.TOTAL_MES;
            if (mi < bloco.mesesData.length - 1) alturaTotal += H.GAP_MES;
        });
        if (bloco.mesesData.length > 1) alturaTotal += H.TOTAL_GER + 8;
        alturaTotal += H.GAP_PESSOA;
    });
    alturaTotal += H.FOOTER;

    // ── Canvas ────────────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.width  = W * SCALE;
    canvas.height = alturaTotal * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.scale(SCALE, SCALE);

    // ── Funções de desenho utilitárias ────────────────────
    function rrect(x, y, w, h, r) {
        ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
    }
    function linha(x1, y1, x2, y2, cor, lw, dash) {
        ctx.save();
        ctx.strokeStyle = cor; ctx.lineWidth = lw || 1;
        if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.restore();
    }
    function texto(txt, x, y, cor, fonte, align) {
        ctx.fillStyle = cor; ctx.font = fonte;
        ctx.textAlign = align || 'left';
        ctx.fillText(txt, x, y);
        ctx.textAlign = 'left';
    }
    function valorDireita(val, y, cor) {
        texto(formatarMoeda(val), W - PAD, y, cor, 'bold 13px Inter,Arial,sans-serif', 'right');
    }

    // ── Fundo ──────────────────────────────────────────────
    ctx.fillStyle = '#181311';
    ctx.fillRect(0, 0, W, alturaTotal);

    // Faixa colorida no topo
    ctx.fillStyle = '#D98A98';
    ctx.fillRect(0, 0, W, 4);

    let y = 20;

    // ── Cabeçalho ──────────────────────────────────────────
    // Ícone + Título
    texto('Extrato Financeiro', PAD, y + 30, '#ffffff', 'bold 28px Inter,Arial,sans-serif');
    texto('Financeiro 2026 PRO  •  ' + new Date().toLocaleDateString('pt-BR'), PAD, y + 54, 'rgba(255,255,255,0.35)', '12px Inter,Arial,sans-serif');

    // Período no canto direito
    const periodoTxt = mesesSel.length === 1
        ? mesesNome[parseInt(mesesSel[0].split('-')[1])-1] + ' ' + mesesSel[0].split('-')[0]
        : mesesSel.length + ' meses';
    texto(periodoTxt, W - PAD, y + 30, '#D98A98', 'bold 14px Inter,Arial,sans-serif', 'right');
    texto(pessoasSel.length + ' pessoa(s)', W - PAD, y + 50, 'rgba(255,255,255,0.3)', '11px Inter,Arial,sans-serif', 'right');

    y += H.HEADER - 4;
    linha(PAD, y, W - PAD, y, 'rgba(255,255,255,0.08)', 1);
    y += 14;

    // ── Blocos por pessoa ──────────────────────────────────
    blocos.forEach(function(bloco, bi) {

        // Card da pessoa
        ctx.fillStyle = 'rgba(217,138,152,0.14)';
        rrect(PAD - 12, y, INNER + 24, H.PESSOA - 8, 10);
        // Barra lateral azul
        ctx.fillStyle = '#D98A98';
        rrect(PAD - 12, y, 3, H.PESSOA - 8, 2);
        // Nome
        texto(bloco.pessoaNome, PAD + 6, y + 31, '#ffffff', 'bold 17px Inter,Arial,sans-serif');
        // Total geral à direita
        if (bloco.mesesData.length > 1) {
            texto('Total ' + formatarMoeda(bloco.totalGeral), W - PAD, y + 31, '#D98A98', 'bold 14px Inter,Arial,sans-serif', 'right');
        }
        y += H.PESSOA + 4;

        bloco.mesesData.forEach(function(m, mi) {

            // ── Cabeçalho do mês ──────────────────────────
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            rrect(PAD - 4, y, INNER + 8, H.MES, 8);
            texto(m.nomeMes.toUpperCase(), PAD + 6, y + 24, 'rgba(255,255,255,0.5)', 'bold 11px Inter,Arial,sans-serif');
            y += H.MES + 4;

            // ── Categorias ────────────────────────────────
            const cats = Object.keys(m.catMap).sort();
            if (cats.length === 0) {
                texto('Sem lançamentos neste mês', PAD + 8, y + 14, 'rgba(255,255,255,0.25)', 'italic 12px Inter,Arial,sans-serif');
                y += H.ITEM + 12;
            } else {
                cats.forEach(function(cn, ci) {
                    const cat = m.catMap[cn];
                    const isCreditCard = cn.startsWith('Cartao');

                    // Fundo alternado levíssimo
                    if (ci % 2 === 0) {
                        ctx.fillStyle = 'rgba(255,255,255,0.015)';
                        ctx.fillRect(PAD - 4, y, INNER + 8, H.CAT);
                    }

                    // Bolinha indicadora
                    const dotColor = isCreditCard ? '#B88F76' : '#CDBFA3';
                    ctx.fillStyle = dotColor;
                    ctx.beginPath(); ctx.arc(PAD + 7, y + H.CAT/2, 3, 0, Math.PI*2); ctx.fill();

                    // Nome da categoria
                    texto(cn.replace('Cartao ', 'Cartão '), PAD + 18, y + H.CAT/2 + 5, 'rgba(255,255,255,0.75)', '13px Inter,Arial,sans-serif');

                    // Valor
                    valorDireita(cat.total, y + H.CAT/2 + 5, isCreditCard ? '#B88F76' : '#CDBFA3');

                    y += H.CAT;

                    // Itens detalhados
                    if (detalhar) {
                        cat.itens.forEach(function(item) {
                            // Truncar descrição longa
                            ctx.font = '11px Inter,Arial,sans-serif';
                            const maxW = INNER - 120;
                            let desc = item.desc;
                            while (ctx.measureText('   ' + desc).width > maxW && desc.length > 2)
                                desc = desc.slice(0, -1);
                            if (desc !== item.desc) desc += '…';
                            texto('   ' + desc, PAD + 20, y + H.ITEM - 5, 'rgba(255,255,255,0.28)', '11px Inter,Arial,sans-serif');
                            texto(formatarMoeda(item.valor), W - PAD, y + H.ITEM - 5, 'rgba(255,255,255,0.28)', '11px Inter,Arial,sans-serif', 'right');
                            y += H.ITEM;
                        });
                    }
                });
            }

            // ── Total do mês ──────────────────────────────
            y += 6;
            linha(PAD - 4, y, W - PAD + 4, y, 'rgba(201,189,164,0.2)', 1);
            y += 4;
            ctx.fillStyle = 'rgba(201,189,164,0.07)';
            ctx.fillRect(PAD - 4, y, INNER + 8, H.TOTAL_MES - 8);
            texto('Total ' + m.nomeMes, PAD + 8, y + 20, '#C9BDA4', 'bold 13px Inter,Arial,sans-serif');
            texto(formatarMoeda(m.totalMes), W - PAD, y + 20, '#C9BDA4', 'bold 14px Inter,Arial,sans-serif', 'right');
            y += H.TOTAL_MES;

            if (mi < bloco.mesesData.length - 1) y += H.GAP_MES;
        });

        // ── Total geral (múltiplos meses) ─────────────────
        if (bloco.mesesData.length > 1) {
            y += 10;
            ctx.fillStyle = 'rgba(217,138,152,0.12)';
            rrect(PAD - 4, y, INNER + 8, H.TOTAL_GER - 8, 8);
            ctx.fillStyle = 'rgba(217,138,152,0.5)';
            rrect(PAD - 4, y, 3, H.TOTAL_GER - 8, 2);
            texto('TOTAL GERAL', PAD + 8, y + 26, '#D98A98', 'bold 14px Inter,Arial,sans-serif');
            texto(formatarMoeda(bloco.totalGeral), W - PAD, y + 26, '#D98A98', 'bold 16px Inter,Arial,sans-serif', 'right');
            y += H.TOTAL_GER + 2;
        }

        // Separador entre pessoas
        if (bi < blocos.length - 1) {
            y += 16;
            linha(PAD, y, W - PAD, y, 'rgba(255,255,255,0.06)', 1, [6, 4]);
        }
        y += H.GAP_PESSOA;
    });

    // ── Rodapé ────────────────────────────────────────────
    y += 8;
    linha(PAD, y, W - PAD, y, 'rgba(255,255,255,0.06)', 1);
    y += 14;
    texto('Gerado pelo Financeiro 2026 PRO', PAD, y + 14, 'rgba(255,255,255,0.15)', '11px Inter,Arial,sans-serif');
    // Faixa final
    ctx.fillStyle = '#D98A98';
    ctx.fillRect(0, alturaTotal - 3, W, 3);

    // ── Download ──────────────────────────────────────────
    const nomes  = pessoasSel.map(function(id) {
        const p = db_pessoas.find(function(x){ return x.id === id; });
        return p ? p.nome.replace(/\s+/g,'') : id;
    }).join('_');
    const periodo = mesesSel.length === 1
        ? mesesSel[0]
        : mesesSel[0] + '_a_' + mesesSel[mesesSel.length-1];
    const link = document.createElement('a');
    link.download = 'extrato_' + nomes + '_' + periodo + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
}


// ==== FUNÇÕES DE DIAGNÓSTICO ====

function abrirDiagnostico() {
    const vCfg = document.getElementById('view-configs');
    const vDiag = document.getElementById('view-config-diagnostico');
    if (vCfg) vCfg.classList.add('hidden');
    if (vDiag) vDiag.classList.remove('hidden');
    gerarDiagnostico();
}

function gerarDiagnostico() {
    const linhas = [];
    linhas.push('===== DIAGNÓSTICO FINANCEIRO 2026 PRO =====');
    linhas.push('Data/hora: ' + new Date().toLocaleString('pt-BR'));
    linhas.push('Navegador: ' + navigator.userAgent.split(') ')[0].split('(').pop());
    linhas.push('');

    // Estado dos dados
    linhas.push('--- DADOS CARREGADOS ---');
    try {
        linhas.push('Pessoas: ' + (typeof db_pessoas !== 'undefined' ? db_pessoas.length : 'NÃO CARREGADO'));
        linhas.push('Cartões: ' + (typeof db_cartoes !== 'undefined' ? db_cartoes.length : 'NÃO CARREGADO'));
        linhas.push('Categorias: ' + (typeof db_categorias !== 'undefined' ? db_categorias.length : 'NÃO CARREGADO'));
        linhas.push('Faturas: ' + (typeof db_faturas !== 'undefined' ? db_faturas.length : 'NÃO CARREGADO'));
        linhas.push('Gastos pontuais: ' + (typeof db_gastos_pontuais !== 'undefined' ? db_gastos_pontuais.length : 'NÃO CARREGADO'));
        linhas.push('Regras fixas: ' + (typeof db_regras_gastos_fixos !== 'undefined' ? db_regras_gastos_fixos.length : 'NÃO CARREGADO'));
    } catch(e) {
        linhas.push('ERRO ao ler dados: ' + e.message);
    }
    linhas.push('');

    // Estado da interface
    linhas.push('--- INTERFACE ---');
    linhas.push('Mês selecionado: ' + (typeof dataAtual !== 'undefined' ? (dataAtual.getMonth()+1) + '/' + dataAtual.getFullYear() : 'N/D'));
    linhas.push('Painel aberto: ' + (typeof painelAberto !== 'undefined' ? (painelAberto || 'nenhum') : 'N/D'));
    linhas.push('');

    // Verificação de funções essenciais
    linhas.push('--- FUNÇÕES ESSENCIAIS ---');
    const fns = ['renderizarApp','renderizarDashboard','mudarMes','abrirPainel','sincronizar'];
    fns.forEach(function(fn) {
        linhas.push(fn + ': ' + (typeof window[fn] === 'function' ? 'OK' : 'AUSENTE'));
    });
    linhas.push('');

    // Log de erros
    linhas.push('--- ERROS REGISTRADOS (' + window._logErros.length + ') ---');
    if (window._logErros.length === 0) {
        linhas.push('Nenhum erro registrado nesta sessão.');
    } else {
        window._logErros.forEach(function(err, i) {
            linhas.push((i+1) + '. [' + err.hora + '] ' + err.tipo + ': ' + err.msg + (err.origem ? ' (' + err.origem + ')' : ''));
        });
    }
    linhas.push('');
    linhas.push('===== FIM DO RELATÓRIO =====');

    const texto = linhas.join('\n');
    const ta = document.getElementById('diag-texto');
    if (ta) ta.value = texto;

    // Atualizar status visual
    const status = document.getElementById('diag-status');
    if (status) {
        if (window._logErros.length === 0) {
            status.style.background = 'color-mix(in srgb, var(--success) 10%, transparent)';
            status.style.borderColor = 'color-mix(in srgb, var(--success) 30%, transparent)';
            status.innerHTML = '<div style="font-size:32px;margin-bottom:6px;"><svg class="ic"><use href="#i-checkc"/></svg></div>' +
                '<div style="font-size:14px;font-weight:700;color:var(--success);">Sistema funcionando normalmente</div>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Nenhum erro detectado</div>';
        } else {
            status.style.background = 'color-mix(in srgb, var(--danger) 10%, transparent)';
            status.style.borderColor = 'color-mix(in srgb, var(--danger) 30%, transparent)';
            status.innerHTML = '<div style="font-size:32px;margin-bottom:6px;"><svg class="ic"><use href="#i-alert"/></svg></div>' +
                '<div style="font-size:14px;font-weight:700;color:var(--danger);">' + window._logErros.length + ' erro(s) detectado(s)</div>' +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Copie o relatório e envie para suporte</div>';
        }
    }
}

function copiarDiagnostico() {
    const ta = document.getElementById('diag-texto');
    if (!ta) return;
    ta.select();
    try {
        navigator.clipboard.writeText(ta.value).then(function() {
            alert('Relatório copiado! Agora é só colar (Ctrl+V) onde quiser.');
        }).catch(function() {
            document.execCommand('copy');
            alert('Relatório copiado!');
        });
    } catch(e) {
        document.execCommand('copy');
        alert('Relatório copiado!');
    }
}

function limparLogErros() {
    window._logErros = [];
    gerarDiagnostico();
}

// ==== MÓDULO CONFIGURAÇÕES ====
function abrirConfigGastosFixos() { document.getElementById('view-configs').classList.add('hidden'); document.getElementById('view-config-gastos-fixos').classList.remove('hidden'); renderizarListaRegrasGastosFixos(); }
function voltarParaConfigsGastosFixos() { document.getElementById('view-config-gastos-fixos').classList.add('hidden'); document.getElementById('view-configs').classList.remove('hidden'); }
function abrirConfigEntradas() { /* removido — gerenciamento agora na aba Entradas */ }
function voltarParaConfigsEntradas() { const v = document.getElementById("view-configs"); if (v) v.classList.remove("hidden"); }
function abrirConfigCartoes() { document.getElementById('view-configs').classList.add('hidden'); document.getElementById('view-config-cartoes').classList.remove('hidden'); renderizarListaCartoes(); }
function voltarParaConfigsCartoes() { document.getElementById('view-config-cartoes').classList.add('hidden'); document.getElementById('view-configs').classList.remove('hidden'); fecharEdicaoCartao(); }


// ==== LÓGICA DE GASTOS PONTUAIS E REGRAS DE GASTOS FIXOS ====

// Gera automaticamente os gastos fixos do mês (igual ao sistema de entradas fixas)
// Se já foi gerado, não sobrescreve. Se o usuário editou o valor, também não sobrescreve.
function verificarEGerarGastosFixos() {
    const mesAnoAtual = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    let mudou = false;
    db_regras_gastos_fixos.forEach(function(regra) {
        if (mesAnoAtual >= regra.inicio) {
            const jaExiste = db_gastos_pontuais.find(function(g) { return g.origem_regra === regra.id && g.mes_ref === mesAnoAtual; });
            const foiPulado = (regra.meses_pulados || []).indexOf(mesAnoAtual) !== -1;   // excluído "só este mês"
            if (!jaExiste && !foiPulado) {
                db_gastos_pontuais.push({
                    id: 'gp_' + Date.now() + '_' + Math.floor(Math.random()*9999),
                    desc: regra.desc,
                    valor: regra.valor,
                    data: mesAnoAtual + '-' + String(regra.dia).padStart(2, '0'),
                    mes_ref: mesAnoAtual,
                    cat_id: regra.cat_id,
                    subcat_id: regra.subcat_id,
                    divisao: JSON.parse(JSON.stringify(regra.divisao)),
                    origem_regra: regra.id,
                    valor_editado: false
                });
                mudou = true;
            }
        }
    });
    if (mudou) sincronizarGastosPontuais();
}

function adicionarDonoRGF(pessoaId, valorInicial) {
    pessoaId = pessoaId || '';
    const container = document.getElementById('container-donos-rgf');
    const options = db_pessoas.map(function(p) {
        return '<option value="' + p.id + '"' + (pessoaId === p.id ? ' selected' : '') + '>' + p.nome + '</option>';
    }).join('');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:center;';
    row.innerHTML = '<select class="form-control select-dono-rgf" style="flex:1;" onchange="redistribuirIgualRGF()">' + options + '</select>' +
        '<input type="number" step="0.01" class="form-control input-valor-dono-rgf" placeholder="R$" style="width:85px;flex:none;color:var(--success);" oninput="this.dataset.manual=1">' +
        '<button onclick="this.parentElement.remove(); redistribuirIgualRGF();" style="background:var(--danger-bg);color:white;border:none;border-radius:8px;padding:0 10px;height:44px;cursor:pointer;font-weight:bold;flex:none;"><svg class="ic"><use href="#i-x"/></svg></button>';
    container.appendChild(row);

    const inputValor = row.querySelector('.input-valor-dono-rgf');
    if (valorInicial !== undefined) {
        inputValor.value = Number(valorInicial).toFixed(2);
    } else {
        redistribuirIgualRGF();
    }
}

function atualizarSubcategoriasRGF() {
    const catId = document.getElementById('rgf-cat').value;
    const subSelect = document.getElementById('rgf-subcat');
    const cat = db_categorias.find(function(c) { return c.id === catId; });
    if (cat && cat.subcategorias.length > 0) {
        subSelect.innerHTML = cat.subcategorias.map(function(s) { return '<option value="' + s.id + '">' + s.nome + '</option>'; }).join('');
        subSelect.disabled = false;
    } else {
        subSelect.innerHTML = '<option value="">Sem subcategorias</option>';
        subSelect.disabled = true;
    }
}

function salvarRegraGastoFixo() {
    const desc    = document.getElementById('rgf-desc').value.trim();
    const valor   = parseFloat(document.getElementById('rgf-valor').value);
    const dia     = document.getElementById('rgf-dia').value || '01';
    const catId   = document.getElementById('rgf-cat').value;
    const subCatId = document.getElementById('rgf-subcat').value;
    const selectsDonos  = document.querySelectorAll('.select-dono-rgf');
    const inputsValores = document.querySelectorAll('.input-valor-dono-rgf');

    if (!desc || isNaN(valor)) return alert('Preencha descricao e valor!');
    if (selectsDonos.length === 0) return alert('Adicione pelo menos uma pessoa!');

    const qtd = selectsDonos.length;
    const divisao = Array.from(selectsDonos).map(function(s, i) {
        const v = inputsValores[i] ? parseFloat(inputsValores[i].value) : NaN;
        return { pessoa_id: s.value, valor: isNaN(v) ? valor / qtd : v };
    });

    const mesCriacao = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    db_regras_gastos_fixos.push({
        id: 'rgf_' + Date.now(), desc: desc, valor: valor,
        dia: dia, cat_id: catId, subcat_id: subCatId,
        inicio: mesCriacao, divisao: divisao
    });

    // Limpa o formulário
    document.getElementById('rgf-desc').value = '';
    document.getElementById('rgf-valor').value = '';
    document.getElementById('rgf-dia').value = '';
    document.getElementById('container-donos-rgf').innerHTML = '';
    adicionarDonoRGF(); // volta com 1 pessoa padrão

    sincronizarRegrasGastosFixos();
}

function deletarRegraGastoFixo(id) {
    salvarSnapshotUndo('excluir regra de gasto fixo');
    if (confirm('Deletar esta regra? Os gastos ja lancados nos meses anteriores serao mantidos.')) {
        db_regras_gastos_fixos = db_regras_gastos_fixos.filter(function(r) { return r.id !== id; });
        sincronizarRegrasGastosFixos();
        renderizarListaRegrasGastosFixos();
    }
}

function renderizarListaRegrasGastosFixos() {
    const catSelect = document.getElementById('rgf-cat');
    if (catSelect) {
        catSelect.innerHTML = db_categorias.map(function(c) { return '<option value="' + c.id + '">' + c.nome + '</option>'; }).join('');
        atualizarSubcategoriasRGF();
    }
    const container = document.getElementById('container-donos-rgf');
    if (container && container.children.length === 0) adicionarDonoRGF();
    const lista = document.getElementById('lista-regras-gastos-fixos');
    if (!lista) return;
    if (db_regras_gastos_fixos.length === 0) {
        lista.innerHTML = '<p style="color:grey;font-size:11px;">Nenhum gasto fixo cadastrado.</p>';
        return;
    }
    lista.innerHTML = db_regras_gastos_fixos.map(function(r) {
        const cat = db_categorias.find(function(c) { return c.id === r.cat_id; });
        return '<div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface-2);padding:12px;border-radius:10px;border:1px solid var(--border);margin-bottom:8px;">' +
            '<div><span style="font-size:13px;font-weight:600;">' + r.desc + '</span><br>' +
            '<small style="color:var(--text-muted)">R$ ' + Number(r.valor).toFixed(2) + ' - Dia ' + r.dia + ' - ' + (cat ? cat.nome : 'Sem cat') + '</small></div>' +
            '<button onclick="deletarRegraGastoFixo(\'' + r.id + '\')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:18px;font-weight:bold;">x</button>' +
            '</div>';
    }).join('');
}

function editarValorGastoPontual(id, novoValor) {
    const g = db_gastos_pontuais.find(function(x) { return x.id === id; });
    if (!g) return;
    const valorNum = parseFloat(novoValor);
    if (isNaN(valorNum)) return;
    const fator = valorNum / g.valor;
    g.valor = valorNum;
    g.valor_editado = true;
    g.divisao.forEach(function(d) { d.valor *= fator; });
    sincronizarGastosPontuais();
}


// ==== EDIÇÃO DE GASTOS PONTUAIS ====
let _gpEditId = null; // ID do gasto em edicao
let _catExpandidas = {};
let _dashOrcExpandido = false;
function toggleDashOrc() { _dashOrcExpandido = !_dashOrcExpandido; renderizarDashboard(); } // { 'NomeCategoria': true } — expansao de subcats no dashboard

function toggleCatExpansao(idx) {
    // idx é o índice no array cats[], que é reconstruído a cada render
    // Usamos o idx para encontrar o nome correspondente via DOM (data-catidx)
    const el = document.querySelector("[data-catidx='" + idx + "'");
    const nome = el ? el.dataset.catnome : null;
    if (!nome) return;
    _catExpandidas[nome] = !_catExpandidas[nome];
    renderizarDashboard();
}

function editarGastoPontual(id) {
    _gpEditId = id;
    const g = db_gastos_pontuais.find(function(x) { return x.id === id; });
    if (!g) return;
    // Se parcelado com grupo: abre modal completo
    if (g.total_parcelas > 1 && g.id_grupo) { abrirEdicaoParcelasPontual(id); return; }

    const cat   = db_categorias.find(function(c) { return c.id === g.cat_id; });
    const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const nomeMes = meses[dataAtual.getMonth()];
    const isParcelado = g.total_parcelas > 1;

    const modalAnt = document.getElementById('modal-editar-gp');
    if (modalAnt) modalAnt.remove();

    // Linhas de divisão por pessoa
    const linhasDivisao = g.divisao.map(function(d) {
        const p = db_pessoas.find(function(x) { return x.id === d.pessoa_id; });
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--w-06);">' +
               '<span style="font-size:13px;color:var(--text-main);">' + (p ? p.nome : '?') + '</span>' +
               '<input type="number" step="0.01" class="input-quick gpei-val" data-pessoa="' + d.pessoa_id + '" value="' + d.valor.toFixed(2) + '" oninput="gpeiTotal()" style="width:100px;"></div>';
    }).join('');

    // Selectbox de categorias
    const catOpts = db_categorias.map(function(c) {
        return '<option value="' + c.id + '"' + (c.id === g.cat_id ? ' selected' : '') + '>' + c.nome + '</option>';
    }).join('');

    // Selectbox de subcategorias
    const subOpts = cat ? cat.subcategorias.map(function(s) {
        return '<option value="' + s.id + '"' + (s.id === g.subcat_id ? ' selected' : '') + '>' + s.nome + '</option>';
    }).join('') : '<option value="">Sem subcategorias</option>';

    const overlay = document.createElement('div');
    overlay.id = 'modal-editar-gp';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.72);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

    const box = document.createElement('div');
    box.style.cssText = 'background:rgba(15,20,42,0.97);border:1px solid var(--w-13);border-radius:18px;width:92%;max-width:420px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,0.85);display:flex;flex-direction:column;gap:14px;max-height:90vh;overflow-y:auto;';

    box.innerHTML =
        // Cabeçalho
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<h3 style="color:var(--primary);margin:0;font-size:16px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar Gasto</h3>' +
        '<button id="gpei-btn-fechar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:20px;"><svg class="ic"><use href="#i-x"/></svg></button></div>' +

        // Info de parcelamento
        (isParcelado ? '<div style="font-size:11px;color:var(--text-muted);padding:8px 12px;background:color-mix(in srgb, var(--accent) 8%, transparent);border-radius:8px;border:1px solid color-mix(in srgb, var(--accent) 20%, transparent);">Parcela <strong style="color:var(--info);">' + g.parcela_num + ' de ' + g.total_parcelas + '</strong> — Escolha o escopo ao salvar.</div>' : '') +

        // Descrição
        '<div><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;display:block;margin-bottom:6px;">DESCRIÇÃO</label>' +
        '<input id="gpei-desc" type="text" class="form-control" value="' + g.desc + '"></div>' +

        // Data
        '<div><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;display:block;margin-bottom:6px;">DATA DO PAGAMENTO</label>' +
        '<input id="gpei-data" type="date" class="form-control" value="' + g.data + '"></div>' +

        // Categoria + Sub
        '<div style="display:flex;gap:10px;">' +
        '<div style="flex:1;"><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;display:block;margin-bottom:6px;">CATEGORIA</label>' +
        '<select id="gpei-cat" class="form-control" onchange="gpeiAtualizarSub()">' + catOpts + '</select></div>' +
        '<div style="flex:1;"><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;display:block;margin-bottom:6px;">SUBCATEGORIA</label>' +
        '<select id="gpei-sub" class="form-control">' + subOpts + '</select></div></div>' +

        // Pessoas — container dinâmico (igual ao modal de fixos)
        '<div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;">PESSOAS E VALORES</label>' +
        '<button id="gpei-btn-add" style="background:var(--accent);color:var(--on-accent);border:none;border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer;">+ Pessoa</button>' +
        '</div>' +
        '<div id="gpei-donos" style="display:flex;flex-direction:column;gap:6px;"></div>' +
        '</div>' +

        // Total ao vivo
        '<div style="padding:8px 12px;background:var(--k-25);border-radius:8px;text-align:center;">' +
        '<span style="font-size:11px;color:var(--text-muted);">TOTAL: </span>' +
        '<span id="gpei-total" style="font-weight:800;color:var(--warning);font-size:16px;">' + formatarMoeda(g.valor) + '</span></div>' +

        // Botões — sem parcelamento: só salvar; com parcelamento: 3 opções
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
        (isParcelado ?
            '<button id="gpei-btn-todos" style="background:var(--accent);color:var(--on-accent);border:none;border-radius:10px;padding:12px;cursor:pointer;font-weight:700;font-size:13px;">Salvar em todas as parcelas (' + g.total_parcelas + 'x)</button>' +
            '<button id="gpei-btn-futuras" style="background:color-mix(in srgb, var(--accent) 15%, transparent);color:var(--info);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);border-radius:10px;padding:12px;cursor:pointer;font-weight:600;font-size:13px;">Salvar desta parcela em diante (' + (g.total_parcelas - g.parcela_num + 1) + 'x)</button>' +
            '<button id="gpei-btn-atual" style="background:var(--w-06);color:var(--text-main);border:1px solid var(--w-12);border-radius:10px;padding:12px;cursor:pointer;font-weight:600;font-size:13px;">Salvar só esta parcela</button>'
        :
            '<button id="gpei-btn-atual" style="background:var(--accent);color:var(--on-accent);border:none;border-radius:10px;padding:12px;cursor:pointer;font-weight:700;font-size:14px;">Salvar alterações</button>'
        ) +
        '<button id="gpei-btn-cancelar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:8px;font-size:13px;">Cancelar</button>' +
        '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#gpei-btn-fechar').addEventListener('click',   function() { overlay.remove(); });
    box.querySelector('#gpei-btn-cancelar').addEventListener('click', function() { overlay.remove(); });
    box.querySelector('#gpei-btn-atual').addEventListener('click',    function() { gpeiSalvar('atual');   overlay.remove(); });
    // Popular container de pessoas com linhas dinâmicas
    g.divisao.forEach(function(d) { gpeiAdicionarPessoa(d.pessoa_id, d.valor); });
    const gpeiAddBtn = box.querySelector('#gpei-btn-add');
    if (gpeiAddBtn) gpeiAddBtn.addEventListener('click', function() { gpeiAdicionarPessoa(); setTimeout(gpeiRedistribuir, 50); });
    if (isParcelado) {
        box.querySelector('#gpei-btn-todos').addEventListener('click',   function() { gpeiSalvar('todos');   overlay.remove(); });
        box.querySelector('#gpei-btn-futuras').addEventListener('click', function() { gpeiSalvar('futuras'); overlay.remove(); });
    }

    setTimeout(function() {
        const el = box.querySelector('#gpei-desc');
        if (el) el.focus();
    }, 60);
}

function gpeiAdicionarPessoa(pessoaId, valor) {
    const container = document.getElementById('gpei-donos');
    if (!container) return;
    const opts = db_pessoas.map(function(p) {
        return '<option value="' + p.id + '"' + (pessoaId === p.id ? ' selected' : '') + '>' + p.nome + '</option>';
    }).join('');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const sel = document.createElement('select');
    sel.className = 'form-control gpei-sel-pessoa'; sel.style.flex = '1';
    sel.innerHTML = opts;
    sel.addEventListener('change', gpeiTotal);
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.01';
    inp.className = 'input-quick gpei-val-pessoa'; inp.style.width = '100px';
    inp.value = valor !== undefined ? Number(valor).toFixed(2) : '';
    inp.placeholder = 'R$';
    inp.addEventListener('input', gpeiTotal);
    const btn = document.createElement('button');
    btn.style.cssText = 'background:color-mix(in srgb, var(--danger) 15%, transparent);border:1px solid color-mix(in srgb, var(--danger) 30%, transparent);color:var(--danger);border-radius:7px;padding:0 10px;height:40px;cursor:pointer;font-size:14px;flex-shrink:0;';
    btn.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    btn.addEventListener('click', function() { row.remove(); gpeiTotal(); });
    row.appendChild(sel); row.appendChild(inp); row.appendChild(btn);
    container.appendChild(row);
    gpeiTotal();
}

function gpeiRedistribuir() {
    const inps = document.querySelectorAll('.gpei-val-pessoa');
    const totalEl = document.getElementById('gpei-total');
    if (!totalEl || inps.length === 0) return;
    const total = parseFloat(totalEl.textContent.replace(/[R$\s.]/g,'').replace(',','.')) || 0;
    if (total === 0) return;
    inps.forEach(function(inp, i) {
        const base = Math.floor(total / inps.length * 100) / 100;
        inp.value = (i === inps.length - 1 ? (total - base * (inps.length - 1)) : base).toFixed(2);
    });
    gpeiTotal();
}


function gpeiTotal() {
    let t = 0;
    document.querySelectorAll('.gpei-val-pessoa').forEach(function(inp) { t += parseFloat(inp.value) || 0; });
    const el = document.getElementById('gpei-total');
    if (el) el.textContent = formatarMoeda(t);
}

function gpeiAtualizarSub() {
    const catId = document.getElementById('gpei-cat').value;
    const subSel = document.getElementById('gpei-sub');
    const cat = db_categorias.find(function(c) { return c.id === catId; });
    if (cat && cat.subcategorias.length > 0) {
        subSel.innerHTML = cat.subcategorias.map(function(s) {
            return '<option value="' + s.id + '">' + s.nome + '</option>';
        }).join('');
        subSel.disabled = false;
    } else {
        subSel.innerHTML = '<option value="">Sem subcategorias</option>';
        subSel.disabled = true;
    }
}

function gpeiSalvar(modo) {
    const g = db_gastos_pontuais.find(function(x) { return x.id === _gpEditId; });
    if (!g) return;

    const novaDesc  = document.getElementById('gpei-desc').value.trim() || g.desc;
    const novaData  = document.getElementById('gpei-data').value || g.data;
    const novaCat   = document.getElementById('gpei-cat').value;
    const novaSub   = document.getElementById('gpei-sub').value;
    const inputs    = document.querySelectorAll('.gpei-val');

    // Monta nova divisão — usa selects dinâmicos se disponíveis
    const selsGpei = document.querySelectorAll('.gpei-sel-pessoa');
    const valsGpei = document.querySelectorAll('.gpei-val-pessoa');
    let novaDivisao, novoValor;
    if (selsGpei.length > 0) {
        novaDivisao = []; novoValor = 0;
        selsGpei.forEach(function(sel, i) {
            const v = parseFloat(valsGpei[i] ? valsGpei[i].value : 0) || 0;
            novaDivisao.push({ pessoa_id: sel.value, valor: v });
            novoValor += v;
        });
    } else {
        novaDivisao = Array.from(inputs).map(function(inp) {
            return { pessoa_id: inp.dataset.pessoa, valor: parseFloat(inp.value) || 0 };
        });
        novoValor = novaDivisao.reduce(function(s, d) { return s + d.valor; }, 0);
    }

    // Determina quais registros serão afetados
    let alvos = [];
    if (modo === 'todos' && g.id_grupo) {
        alvos = db_gastos_pontuais.filter(function(x) { return x.id_grupo === g.id_grupo; });
    } else if (modo === 'futuras' && g.id_grupo) {
        alvos = db_gastos_pontuais.filter(function(x) {
            return x.id_grupo === g.id_grupo && x.parcela_num >= g.parcela_num;
        });
    } else {
        alvos = [g]; // só atual
    }

    alvos.forEach(function(alvo) {
        alvo.desc        = novaDesc;
        alvo.cat_id      = novaCat;
        alvo.subcat_id   = novaSub;
        alvo.valor       = novoValor;
        alvo.divisao     = novaDivisao.map(function(d) { return { pessoa_id: d.pessoa_id, valor: d.valor }; });
        alvo.valor_editado = true;
        // Data: só atualiza a parcela atual; nas demais avança o mês proporcionalmente
        if (modo === 'atual' || modo === 'todos') {
            alvo.data = novaData;
            const d = new Date(novaData + 'T12:00:00');
            alvo.mes_ref = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        }
    });

    sincronizarGastosPontuais();
}

function deletarGastoPontual(id) {
    salvarSnapshotUndo('excluir gasto pontual');
    const g = db_gastos_pontuais.find(function(x) { return x.id === id; });
    if (!g) return;
    if (g.origem_regra) return alert('Para remover um gasto fixo recorrente, exclua a regra em Configuracoes > Gastos Fixos.');
    if (confirm('Excluir este gasto pontual?')) {
        db_gastos_pontuais = db_gastos_pontuais.filter(function(x) { return x.id !== id; });
        sincronizarGastosPontuais();
    }
}


// ==== FORMULARIO DE GASTOS PONTUAIS (sidebar) ====

function gpInicializarForm() {
    // Preenche categorias
    const catSel = document.getElementById('gp-cat');
    if (catSel) {
        catSel.innerHTML = db_categorias.map(function(c) {
            return '<option value="' + c.id + '">' + c.nome + '</option>';
        }).join('');
        gpAtualizarSub();
    }
    // Data padrao: hoje
    const dataEl = document.getElementById('gp-data');
    if (dataEl && !dataEl.value) {
        const hoje = new Date();
        dataEl.value = hoje.getFullYear() + '-' + String(hoje.getMonth()+1).padStart(2,'0') + '-' + String(hoje.getDate()).padStart(2,'0');
    }
    // Garante ao menos 1 dono
    const container = document.getElementById('gp-donos');
    if (container && container.children.length === 0) gpAdicionarDono();
}

function gpAtualizarSub() {
    const catId = document.getElementById('gp-cat').value;
    const subSel = document.getElementById('gp-sub');
    const cat = db_categorias.find(function(c) { return c.id === catId; });
    if (cat && cat.subcategorias.length > 0) {
        subSel.innerHTML = cat.subcategorias.map(function(s) {
            return '<option value="' + s.id + '">' + s.nome + '</option>';
        }).join('');
        subSel.disabled = false;
    } else {
        subSel.innerHTML = '<option value="">Sem subcategorias</option>';
        subSel.disabled = true;
    }
}

function gpAdicionarDono(pessoaId) {
    pessoaId = pessoaId || '';
    const container = document.getElementById('gp-donos');
    const opts = db_pessoas.map(function(p) {
        return '<option value="' + p.id + '"' + (pessoaId === p.id ? ' selected' : '') + '>' + p.nome + '</option>';
    }).join('');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;';
    row.innerHTML = '<select class="form-control gp-sel-dono" style="flex:1;" onchange="gpRedistribuir()">' + opts + '</select>' +
        '<input type="number" step="0.01" class="form-control gp-val-dono" placeholder="R$" style="width:85px;flex:none;color:var(--success);" oninput="this.dataset.manual=1">' +
        '<button onclick="this.parentElement.remove();gpRedistribuir();" style="background:var(--danger-bg);color:white;border:none;border-radius:8px;padding:0 10px;height:44px;cursor:pointer;font-weight:bold;flex:none;"><svg class="ic"><use href="#i-x"/></svg></button>';
    container.appendChild(row);
    gpRedistribuir();
}

function gpRedistribuir() {
    const valor    = parseFloat(document.getElementById('gp-valor').value) || 0;
    const parcelas = parseInt(document.getElementById('gp-parcelas').value)  || 1;
    const valorParc = valor / parcelas;
    const inputs = document.querySelectorAll('.gp-val-dono');
    if (inputs.length === 0) return;
    const porPessoa = valorParc / inputs.length;
    inputs.forEach(function(inp) {
        if (!inp.dataset.manual) inp.value = porPessoa.toFixed(2);
    });
}

function gpSalvar() {
    const desc     = document.getElementById('gp-desc').value.trim();
    const valor    = parseFloat(document.getElementById('gp-valor').value);
    const parcelas = parseInt(document.getElementById('gp-parcelas').value) || 1;
    const dataStr  = document.getElementById('gp-data').value;
    const catId    = document.getElementById('gp-cat').value;
    const subId    = document.getElementById('gp-sub').value;
    const selsDono = document.querySelectorAll('.gp-sel-dono');
    const valsDono = document.querySelectorAll('.gp-val-dono');

    if (!desc)   return alert('Preencha a descricao!');
    if (isNaN(valor) || valor <= 0) return alert('Preencha o valor!');
    if (!dataStr) return alert('Preencha a data!');
    if (selsDono.length === 0) return alert('Adicione pelo menos uma pessoa!');

    const idGrupo  = parcelas > 1 ? 'gp_grupo_' + Date.now() : null;
    const dataBase = new Date(dataStr + 'T12:00:00');
    const valorParcela = valor / parcelas;

    for (let i = 0; i < parcelas; i++) {
        const dataParc  = new Date(dataBase.getFullYear(), dataBase.getMonth() + i, dataBase.getDate());
        const mesRef    = dataParc.getFullYear() + '-' + String(dataParc.getMonth() + 1).padStart(2, '0');
        const dataFmt   = dataParc.getFullYear() + '-' + String(dataParc.getMonth() + 1).padStart(2, '0') + '-' + String(dataParc.getDate()).padStart(2, '0');
        const qtd       = selsDono.length;
        const divisao   = Array.from(selsDono).map(function(sel, idx) {
            const v = valsDono[idx] ? parseFloat(valsDono[idx].value) : (valorParcela / qtd);
            return { pessoa_id: sel.value, valor: isNaN(v) ? (valorParcela / qtd) : v };
        });

        db_gastos_pontuais.push({
            id:             'gp_' + Date.now() + '_' + i,
            desc:           desc,
            valor:          valorParcela,
            data:           dataFmt,
            mes_ref:        mesRef,
            cat_id:         catId,
            subcat_id:      subId,
            divisao:        divisao,
            origem_regra:   null,
            valor_editado:  false,
            pago:           false,
            id_grupo:       idGrupo,
            parcela_num:    i + 1,
            total_parcelas: parcelas
        });
    }

    // Limpar form
    document.getElementById('gp-desc').value     = '';
    document.getElementById('gp-valor').value    = '';
    document.getElementById('gp-parcelas').value = '1';
    document.getElementById('gp-donos').innerHTML = '';
    gpAdicionarDono();

    sincronizarGastosPontuais();
}

function renderizarAreaPontuais(mesAnoAtual, meses) {
    const area = document.getElementById('area-exibicao-pontuais');
    if (!area) return;
    const gastosMes = db_gastos_pontuais.filter(function(g) { return g.mes_ref === mesAnoAtual && !g.origem_regra; });
    const totalPontuais = gastosMes.reduce(function(acc, g) { return acc + g.valor; }, 0);

    let totalPorPessoa = {};
    gastosMes.forEach(function(g) {
        g.divisao.forEach(function(d) {
            totalPorPessoa[d.pessoa_id] = (totalPorPessoa[d.pessoa_id] || 0) + d.valor;
        });
    });

    const pessoasHtml = Object.keys(totalPorPessoa).map(function(pId) {
        const p = db_pessoas.find(function(x) { return x.id === pId; });
        return `<div style="background:var(--card-bg);padding:10px 16px;border-radius:10px;border:1px solid var(--border);font-size:12px;">
            <span style="color:var(--text-muted);">${p ? p.nome : '?'}:</span>
            <strong style="color:var(--warning);font-size:13px;"> R$ ${totalPorPessoa[pId].toFixed(2)}</strong>
        </div>`;
    }).join('');

    const listaHtml = gastosMes.map(function(g) {
        const cat = db_categorias.find(function(c) { return c.id === g.cat_id; });
        const nomesDivisao = g.divisao.map(function(d) {
            const p = db_pessoas.find(function(x) { return x.id === d.pessoa_id; });
            return p ? p.nome : '?';
        }).join(', ');
        const iconeLabel = g.origem_regra ? '<svg class="ic"><use href="#i-fixos"/></svg>' : '<svg class="ic"><use href="#i-pontual"/></svg>';
        const tagParcela = (g.total_parcelas > 1)
            ? '<strong style="font-size:11px;color:var(--info);font-weight:800;margin-right:5px;">' + g.parcela_num + '/' + g.total_parcelas + '</strong>'
            : '';
        const tagEditado = g.valor_editado
            ? '<span style="font-size:9px;color:var(--warning);background:color-mix(in srgb, var(--warning) 14%, transparent);padding:2px 6px;border-radius:4px;margin-left:6px;">editado</span>'
            : '';
        const partsD = g.data ? g.data.split('-') : [];
        const dataFmt = partsD.length === 3 ? partsD[2]+'/'+partsD[1]+'/'+partsD[0] : '';
        const subcat = (db_categorias.find(function(cc){ return cc.id === g.cat_id; }) || {subcategorias:[]}).subcategorias.find(function(s){ return s.id === g.subcat_id; });
        const btnEditar = g.origem_regra ? '' :
            '<button onclick="editarGastoPontual(\'' + g.id + '\')" style="background:none;border:1px solid var(--border);color:var(--info);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;"><svg class="ic"><use href="#i-edit"/></svg></button>';
        const btnDeletar = g.origem_regra
            ? '<span style="font-size:10px;color:var(--text-muted);padding:0 8px;">fixo</span>'
            : '<button onclick="deletarGastoPontual(\'' + g.id + '\')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-weight:bold;font-size:14px;"><svg class="ic"><use href="#i-x"/></svg></button>';
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px dashed var(--border);">'
            + '<div style="flex:1;min-width:0;">'
            + '<div style="font-size:14px;font-weight:600;color:var(--text-main);margin-bottom:3px;">' + tagParcela + iconeLabel + ' ' + g.desc + tagEditado + '</div>'
            + '<div style="font-size:11px;color:var(--text-muted);">' + (cat ? cat.nome : 'Sem cat') + (subcat ? ' • ' + subcat.nome : '') + ' • ' + dataFmt + ' • ' + nomesDivisao + '</div>'
            + '</div>'
            + '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">'
            + btnEditar
            + btnDeletar + '</div></div>';
    }).join('');

    area.innerHTML = `
        <div style="margin-bottom:25px;border-bottom:1px solid var(--border);padding-bottom:15px;">
            <h3 style="color:var(--primary);font-size:18px;margin:0;"><svg class="ic ic-t"><use href="#i-pontual"/></svg>Gastos Pontuais de ${meses[dataAtual.getMonth()]}</h3>
        </div>
        <div style="background:var(--card-bg);border-radius:12px;border:1px solid var(--border);overflow:hidden;max-width:700px;">
            <div style="background:var(--surface-2);padding:20px;border-bottom:1px solid var(--border);">
                <div style="font-size:11px;color:var(--text-muted);">TOTAL DO MES</div>
                <div style="font-size:28px;font-weight:bold;color:var(--warning);">${formatarMoeda(totalPontuais)}</div>
                <div style="display:flex;gap:10px;margin-top:15px;flex-wrap:wrap;">${pessoasHtml || '<span style="color:grey;font-size:11px;">Sem gastos.</span>'}</div>
            </div>
            <div style="padding:20px;">${listaHtml || '<p style="color:grey;font-size:12px;">Nenhum gasto pontual registrado.</p>'}</div>
        </div>`;
}


// ==== MINI-MODAL DE CATEGORIA (dentro do modal de lançamento) ====

function abrirMiniModalCategoria() {
    const modal = document.getElementById('mini-modal-cat');
    modal.style.display = 'flex';
    document.getElementById('mini-cat-nome').value = '';
    document.getElementById('mini-subcat-nome').value = '';
    miniModalAba('nova');
    document.getElementById('mini-cat-nome').focus();
}

function fecharMiniModalCategoria() {
    document.getElementById('mini-modal-cat').style.display = 'none';
}

function miniModalAba(aba) {
    const isNova = aba === 'nova';
    document.getElementById('mini-aba-nova').style.display   = isNova ? 'flex' : 'none';
    document.getElementById('mini-aba-editar').style.display = isNova ? 'none' : 'flex';
    document.getElementById('mini-tab-nova').style.background    = isNova ? 'var(--accent)' : 'var(--surface-2)';
    document.getElementById('mini-tab-nova').style.color         = isNova ? 'var(--on-accent)' : 'var(--text-muted)';
    document.getElementById('mini-tab-nova').style.border        = isNova ? 'none' : '1px solid var(--border)';
    document.getElementById('mini-tab-editar').style.background  = !isNova ? 'var(--accent)' : 'var(--surface-2)';
    document.getElementById('mini-tab-editar').style.color       = !isNova ? 'var(--on-accent)' : 'var(--text-muted)';
    document.getElementById('mini-tab-editar').style.border      = !isNova ? 'none' : '1px solid var(--border)';
    if (!isNova) miniCarregarCatsNoEdit();
}

function miniCarregarCatsNoEdit() {
    const sel = document.getElementById('mini-edit-cat-sel');
    sel.innerHTML = db_categorias.map(function(c) {
        return '<option value="' + c.id + '">' + c.nome + '</option>';
    }).join('');
    miniCarregarSubcats();
}

function miniCarregarSubcats() {
    const catId = document.getElementById('mini-edit-cat-sel').value;
    const cat = db_categorias.find(function(c) { return c.id === catId; });
    document.getElementById('mini-edit-cat-nome').value = cat ? cat.nome : '';
    const lista = document.getElementById('mini-lista-subcats');
    if (!cat) { lista.innerHTML = ''; return; }
    lista.innerHTML = cat.subcategorias.map(function(s) {
        return '<div style="display:flex;gap:6px;align-items:center;">' +
            '<input type="text" value="' + s.nome + '" data-subid="' + s.id + '" data-catid="' + cat.id + '" ' +
            'class="form-control mini-sub-input" style="flex:1;padding:6px 8px;font-size:12px;" ' +
            'onchange="miniSalvarNomeSub(this)">' +
            '<button onclick="miniDeletarSub(\'' + cat.id + '\',\'' + s.id + '\')" ' +
            'style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;flex-shrink:0;"><svg class="ic"><use href="#i-x"/></svg></button>' +
            '</div>';
    }).join('') || '<p style="font-size:11px;color:grey;margin:0;">Sem subcategorias.</p>';
}

function miniSalvarNomeCategoria() {
    const catId = document.getElementById('mini-edit-cat-sel').value;
    const novoNome = document.getElementById('mini-edit-cat-nome').value.trim();
    if (!novoNome) return alert('Digite o novo nome!');
    const cat = db_categorias.find(function(c) { return c.id === catId; });
    if (cat) { cat.nome = novoNome; sincronizarCategorias(); preencherCamposBase(); miniCarregarCatsNoEdit(); }
}

function miniSalvarNomeSub(input) {
    const catId = input.dataset.catid;
    const subId = input.dataset.subid;
    const novoNome = input.value.trim();
    if (!novoNome) return;
    const cat = db_categorias.find(function(c) { return c.id === catId; });
    if (!cat) return;
    const sub = cat.subcategorias.find(function(s) { return s.id === subId; });
    if (sub) { sub.nome = novoNome; sincronizarCategorias(); preencherCamposBase(); }
}

function miniDeletarSub(catId, subId) {
    if (!confirm('Excluir esta subcategoria?')) return;
    const cat = db_categorias.find(function(c) { return c.id === catId; });
    if (cat) { cat.subcategorias = cat.subcategorias.filter(function(s) { return s.id !== subId; }); sincronizarCategorias(); preencherCamposBase(); miniCarregarSubcats(); }
}

function salvarMiniCategoria() {
    const nomecat = document.getElementById('mini-cat-nome').value.trim();
    const nomesub = document.getElementById('mini-subcat-nome').value.trim();
    if (!nomecat) return alert('Digite o nome da categoria!');

    let cat = db_categorias.find(function(c) { return c.nome.toLowerCase() === nomecat.toLowerCase(); });
    if (!cat) {
        cat = { id: 'c_' + Date.now(), nome: nomecat, subcategorias: [] };
        db_categorias.push(cat);
    }
    if (nomesub) {
        const subExiste = cat.subcategorias.find(function(s) { return s.nome.toLowerCase() === nomesub.toLowerCase(); });
        if (!subExiste) cat.subcategorias.push({ id: 's_' + Date.now(), nome: nomesub });
    }

    sincronizarCategorias();
    preencherCamposBase();
    document.getElementById('novo-lanc-cat').value = cat.id;
    atualizarSubcategoriasModal();
    if (nomesub) {
        const sub = cat.subcategorias.find(function(s) { return s.nome.toLowerCase() === nomesub.toLowerCase(); });
        if (sub) document.getElementById('novo-lanc-subcat').value = sub.id;
    }
    fecharMiniModalCategoria();
}

// ==== LÓGICA DE CARTÕES ====

// Mostra a lista de cartões cadastrados na tela de configurações
function renderizarListaCartoes() {
    const lista = document.getElementById('lista-cartoes-cadastrados');
    if (!lista) return;
    if (db_cartoes.length === 0) {
        lista.innerHTML = '<p style="color:grey; font-size:11px;">Nenhum cartão cadastrado.</p>';
        return;
    }
    lista.innerHTML = db_cartoes.map(c => `
        <div onclick="abrirEdicaoCartao('${c.id}')"
             style="display:flex; justify-content:space-between; align-items:center;
                    background:var(--surface-2); padding:14px; border-radius:10px;
                    border: 1px solid var(--border); border-left: 5px solid ${c.cor};
                    margin-bottom:10px; cursor:pointer; transition: 0.2s;">
            <div>
                <span style="font-size:13px; font-weight:600;">${c.nome}</span><br>
                <small style="color:var(--text-muted)">Vence dia ${c.vencimento}${c.fechamento ? ' &bull; Fecha dia ' + c.fechamento : ' &bull; <span style="color:var(--warning)">sem fechamento definido</span>'}</small>
            </div>
            <span style="color:var(--text-muted); font-size:12px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar</span>
        </div>
    `).join('');
}

// Cadastra um cartão novo
function salvarNovoCartao() {
    const nome = document.getElementById('card-nome').value.trim();
    const venc = document.getElementById('card-venc').value.trim();
    const cor  = document.getElementById('card-cor').value;
    const fechamentoEl = document.getElementById('card-fechamento');
    const fechamento = fechamentoEl ? fechamentoEl.value.trim() : '';
    if (!nome || !venc) return alert("Preencha o nome e o dia de vencimento!");
    db_cartoes.push({ id: 'card_' + Date.now(), nome: nome, vencimento: venc, cor: cor, fechamento: fechamento });
    document.getElementById('card-nome').value = '';
    document.getElementById('card-venc').value = '';
    if (fechamentoEl) fechamentoEl.value = '';
    sincronizarCartoes();
    renderizarListaCartoes();
}

// Abre o formulário de edição preenchido com os dados do cartão clicado
function abrirEdicaoCartao(id) {
    const c = db_cartoes.find(x => x.id === id);
    if (!c) return;
    document.getElementById('edit-card-id').value   = c.id;
    document.getElementById('edit-card-nome').value = c.nome;
    document.getElementById('edit-card-venc').value = c.vencimento;
    document.getElementById('edit-card-cor').value  = c.cor;
    const editFechEl = document.getElementById('edit-card-fechamento');
    if (editFechEl) editFechEl.value = c.fechamento || '';
    document.getElementById('form-novo-cartao').classList.add('hidden');
    document.getElementById('form-editar-cartao').classList.remove('hidden');
}

// Fecha o formulário de edição e volta pro formulário de novo cartão
function fecharEdicaoCartao() {
    document.getElementById('form-editar-cartao').classList.add('hidden');
    document.getElementById('form-novo-cartao').classList.remove('hidden');
}

// Salva as alterações feitas no formulário de edição
function salvarEdicaoCartao() {
    const id = document.getElementById('edit-card-id').value;
    const c  = db_cartoes.find(x => x.id === id);
    if (!c) return;
    c.nome       = document.getElementById('edit-card-nome').value.trim();
    c.vencimento = document.getElementById('edit-card-venc').value.trim();
    c.cor        = document.getElementById('edit-card-cor').value;
    const editFechEl2 = document.getElementById('edit-card-fechamento');
    c.fechamento = editFechEl2 ? editFechEl2.value.trim() : c.fechamento;
    sincronizarCartoes();
    fecharEdicaoCartao();
    renderizarListaCartoes();
}

// Deleta o cartão que está aberto no formulário de edição
function deletarCartaoEmEdicao() {
    salvarSnapshotUndo('excluir cartão');
    const id = document.getElementById('edit-card-id').value;
    // Verifica se existem faturas vinculadas a esse cartão
    const temFaturas = db_faturas.some(f => f.cartao_id === id);
    if (temFaturas) {
        return alert("Este cartão possui faturas vinculadas e não pode ser excluído.\n\nExclua primeiro todos os lançamentos deste cartão.");
    }
    if (confirm("Tem certeza que deseja excluir este cartão?")) {
        db_cartoes = db_cartoes.filter(x => x.id !== id);
        sincronizarCartoes();
        fecharEdicaoCartao();
        renderizarListaCartoes();
    }
}
function abrirConfigPessoas() { document.getElementById('view-configs').classList.add('hidden'); document.getElementById('view-config-pessoas').classList.remove('hidden'); renderizarListaPessoas(); }
function voltarParaConfigsPessoas() { document.getElementById('view-config-pessoas').classList.add('hidden'); document.getElementById('view-configs').classList.remove('hidden'); fecharEdicaoPessoa(); }
function abrirConfigCategorias() { document.getElementById('view-configs').classList.add('hidden'); document.getElementById('view-config-categorias').classList.remove('hidden'); renderizarListaCategorias(); }
function voltarParaConfigsCategorias() { document.getElementById('view-config-categorias').classList.add('hidden'); document.getElementById('view-configs').classList.remove('hidden'); fecharEdicaoCategoria(); }

// ==== LÓGICA DE PESSOAS ====
function salvarPessoaPrincipal() {
    const novoNome = document.getElementById('nome-pessoa-principal').value.trim();
    if(!novoNome) return alert("Nome principal vazio.");
    const p = db_pessoas.find(x => x.tipo === 'principal');
    if(p) p.nome = novoNome;
    sincronizarPessoas();
}
function adicionarPessoaSecundaria() {
    const nome = document.getElementById('nome-nova-pessoa').value.trim();
    if(!nome) return alert("Digite o nome!");
    db_pessoas.push({ id: 'p_' + Date.now(), nome: nome, tipo: 'secundaria' });
    document.getElementById('nome-nova-pessoa').value = '';
    sincronizarPessoas();
}
function abrirEdicaoPessoa(id) {
    const p = db_pessoas.find(p => p.id === id);
    if (!p) return;
    document.getElementById('edit-pessoa-id').value = p.id;
    document.getElementById('edit-pessoa-nome').value = p.nome;
    document.getElementById('form-nova-pessoa').classList.add('hidden');
    document.getElementById('form-editar-pessoa').classList.remove('hidden');
}
function fecharEdicaoPessoa() { document.getElementById('form-editar-pessoa').classList.add('hidden'); document.getElementById('form-nova-pessoa').classList.remove('hidden'); }
function salvarEdicaoPessoa() {
    const id = document.getElementById('edit-pessoa-id').value;
    const novoNome = document.getElementById('edit-pessoa-nome').value.trim();
    const p = db_pessoas.find(p => p.id === id);
    if (p) { p.nome = novoNome; sincronizarPessoas(); fecharEdicaoPessoa(); }
}
function deletarPessoa(id) {
    salvarSnapshotUndo('excluir pessoa');
    if(confirm("Remover esta pessoa?")) { db_pessoas = db_pessoas.filter(p => p.id !== id); sincronizarPessoas(); fecharEdicaoPessoa(); }
}
function renderizarListaPessoas() {
    const principal = db_pessoas.find(p => p.tipo === 'principal');
    if(principal) document.getElementById('nome-pessoa-principal').value = principal.nome;
    const secundarias = db_pessoas.filter(p => p.tipo === 'secundaria');
    document.getElementById('lista-pessoas-cadastradas').innerHTML = secundarias.map(p => `
        <div onclick="abrirEdicaoPessoa('${p.id}')" style="display:flex; justify-content:space-between; align-items:center; background:var(--surface-2); padding:12px; border-radius:10px; border:1px solid var(--border); margin-bottom:8px; cursor:pointer;">
            <span style="font-size: 13px; font-weight:600;">${p.nome}</span>
            <button onclick="event.stopPropagation(); deletarPessoa('${p.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer;"><svg class="ic"><use href="#i-x"/></svg></button>
        </div>
    `).join('') || '<p style="color:grey; font-size:11px;">Sem pessoas secundárias.</p>';
}

// ==== LÓGICA DE CATEGORIAS ====
function adicionarCategoria() {
    const nome = document.getElementById('nome-nova-categoria').value.trim();
    if(!nome) return alert("Nome vazio!");
    db_categorias.push({ id: 'c_' + Date.now(), nome: nome, subcategorias: [] });
    document.getElementById('nome-nova-categoria').value = '';
    sincronizarCategorias();
}
function abrirEdicaoCategoria(id) {
    const cat = db_categorias.find(c => c.id === id);
    if (!cat) return;
    document.getElementById('edit-cat-id').value = cat.id;
    document.getElementById('edit-cat-nome').value = cat.nome;
    document.getElementById('form-nova-categoria').classList.add('hidden');
    document.getElementById('form-editar-categoria').classList.remove('hidden');
    renderizarListaSubcategorias(cat);
}
function fecharEdicaoCategoria() { document.getElementById('form-editar-categoria').classList.add('hidden'); document.getElementById('form-nova-categoria').classList.remove('hidden'); }
function salvarEdicaoCategoria() {
    const id = document.getElementById('edit-cat-id').value;
    const cat = db_categorias.find(c => c.id === id);
    if(cat) { cat.nome = document.getElementById('edit-cat-nome').value.trim(); sincronizarCategorias(); }
}
function deletarCategoriaInteira() {
    salvarSnapshotUndo('excluir categoria');
    const id = document.getElementById('edit-cat-id').value;
    if(confirm("Excluir categoria e todas subcategorias?")) { db_categorias = db_categorias.filter(c => c.id !== id); sincronizarCategorias(); fecharEdicaoCategoria(); }
}
function adicionarSubcategoria() {
    const catId = document.getElementById('edit-cat-id').value;
    const nomeSub = document.getElementById('nome-nova-subcat').value.trim();
    const cat = db_categorias.find(c => c.id === catId);
    if (cat) { cat.subcategorias.push({ id: 's_' + Date.now(), nome: nomeSub }); document.getElementById('nome-nova-subcat').value = ''; sincronizarCategorias(); renderizarListaSubcategorias(cat); }
}
function deletarSubcategoria(subId) {
    salvarSnapshotUndo('excluir subcategoria');
    const catId = document.getElementById('edit-cat-id').value;
    const cat = db_categorias.find(c => c.id === catId);
    if (cat) { cat.subcategorias = cat.subcategorias.filter(s => s.id !== subId); sincronizarCategorias(); renderizarListaSubcategorias(cat); }
}
function renderizarListaSubcategorias(cat) {
    document.getElementById('lista-subcategorias-edit').innerHTML = cat.subcategorias.map(s => `
        <div style="display:flex; gap:6px; align-items:center; margin-bottom:5px;">
            <input type="text" value="${s.nome}" data-subid="${s.id}" data-catid="${cat.id}"
                class="form-control" style="flex:1; padding:6px 10px; font-size:12px;"
                onchange="salvarNomeSubcategoria(this)">
            <button onclick="deletarSubcategoria('${s.id}')"
                style="background:none; border:none; color:var(--danger); cursor:pointer; font-size:16px; flex-shrink:0;"><svg class="ic"><use href="#i-x"/></svg></button>
        </div>
    `).join('') || '<p style="color:grey; font-size:11px;">Sem subcategorias.</p>';
}

function salvarNomeSubcategoria(input) {
    const catId = input.dataset.catid;
    const subId = input.dataset.subid;
    const novoNome = input.value.trim();
    if (!novoNome) return;
    const cat = db_categorias.find(function(c) { return c.id === catId; });
    if (!cat) return;
    const sub = cat.subcategorias.find(function(s) { return s.id === subId; });
    if (sub) { sub.nome = novoNome; sincronizarCategorias(); }
}
function renderizarListaCategorias() {
    document.getElementById('lista-categorias-cadastradas').innerHTML = db_categorias.map(c => `
        <div onclick="abrirEdicaoCategoria('${c.id}')" style="display:flex; justify-content:space-between; padding:12px; background:var(--surface-2); border-radius:10px; border:1px solid var(--border); margin-bottom:8px; cursor:pointer;">
            <div><span style="font-size: 13px; font-weight:600;">${c.nome}</span><br><small style="color:var(--text-muted)">${c.subcategorias.length} sub(s)</small></div>
            <span style="color:var(--text-muted); font-size:12px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar</span>
        </div>
    `).join('') || '<p style="color:grey; font-size:11px;">Nenhuma categoria.</p>';
}

// ==== CONTROLE MODAL LANÇAMENTO E EDIÇÃO FATURAS ====
function abrirModalLancamento() {
    document.getElementById('modal-titulo').innerHTML = '<svg class="ic ic-t"><use href="#i-plus"/></svg>Novo Lançamento';
    document.getElementById('edit-fatura-id').value = "";
    document.getElementById('novo-lanc-desc').value = '';
    document.getElementById('novo-lanc-valor').value = '';
    document.getElementById('novo-lanc-parcelas').value = '1';
    document.getElementById('novo-lanc-parcelas').disabled = false;
    document.getElementById('novo-lanc-fixo').checked = false;
    document.getElementById('novo-lanc-data').valueAsDate = new Date();
    
    preencherCamposBase();
    document.getElementById('container-donos-divida').innerHTML = ''; // Limpa e põe 1 dono padrão
    adicionarDonoDivida();
    
    document.getElementById('modal-lancamento').classList.add('active');
}

function preencherCamposBase() {
    document.getElementById('novo-lanc-cartao-id').innerHTML = db_cartoes.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
    document.getElementById('novo-lanc-cat').innerHTML = db_categorias.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
    alternarCampoCartao();
    atualizarSubcategoriasModal();
}

function atualizarSubcategoriasModal() {
    const catId = document.getElementById('novo-lanc-cat').value;
    const subSelect = document.getElementById('novo-lanc-subcat');
    const cat = db_categorias.find(c => c.id === catId);
    if (cat && cat.subcategorias.length > 0) {
        subSelect.innerHTML = cat.subcategorias.map(s => `<option value="${s.id}">${s.nome}</option>`).join('');
        subSelect.disabled = false;
    } else {
        subSelect.innerHTML = '<option value="">Sem subcategorias</option>';
        subSelect.disabled = true; 
    }
}

function adicionarDonoDivida(pessoaId = "", valorInicial = null) {
    const container = document.getElementById('container-donos-divida');
    const optionsPessoas = db_pessoas.map(p => `<option value="${p.id}" ${pessoaId === p.id ? 'selected' : ''}>${p.nome}</option>`).join('');
    const row = document.createElement('div');
    row.className = 'dono-row';
    row.style.cssText = 'display:flex; gap:8px; align-items:center;';
    row.innerHTML = `
        <select class="form-control select-dono" style="flex:1;" onchange="redistribuirIgual()">${optionsPessoas}</select>
        <input type="number" step="0.01" class="form-control input-valor-dono" placeholder="R$" style="width:90px; flex:none; color:var(--success);" oninput="marcarManual(this)">
        <button onclick="this.parentElement.remove(); redistribuirIgual();" style="background:var(--danger-bg); color:white; border:none; border-radius:8px; padding:0 12px; height:44px; cursor:pointer; font-weight:bold; flex:none;"><svg class="ic"><use href="#i-x"/></svg></button>`;
    container.appendChild(row);

    // Define o valor inicial (quando abre edição ou ao adicionar redistribui igual)
    const inputValor = row.querySelector('.input-valor-dono');
    if (valorInicial !== null) {
        inputValor.value = valorInicial.toFixed(2);
    } else {
        redistribuirIgual(); // divide o total atual igualmente entre todos
    }
}

// Divide o valor total igualmente entre todos os donos que NÃO foram editados manualmente
function redistribuirIgual() {
    const valorTotal = parseFloat(document.getElementById('novo-lanc-valor').value) || 0;
    const parcelas   = parseInt(document.getElementById('novo-lanc-parcelas').value) || 1;
    const valorParcela = valorTotal / parcelas;

    const rows = document.querySelectorAll('.dono-row');
    if (rows.length === 0) return;

    const valorPorPessoa = valorParcela / rows.length;
    rows.forEach(function(row) {
        const input = row.querySelector('.input-valor-dono');
        // Só redistribui se o campo não foi marcado como manual
        if (!input.dataset.manual) {
            input.value = valorPorPessoa.toFixed(2);
        }
    });
}

// Marca o campo como "editado manualmente" para redistribuirIgual não sobrescrever
function marcarManual(input) {
    input.dataset.manual = '1';
}

// Chamado quando valor total ou parcelas mudam — redistribui os campos automáticos
function onValorOuParcelasChange() {
    // Remove marca manual de todos e redistribui do zero
    document.querySelectorAll('.input-valor-dono').forEach(function(i) { delete i.dataset.manual; });
    redistribuirIgual();
}

function fecharModalLancamento() { document.getElementById('modal-lancamento').classList.remove('active'); }
function alternarCampoCartao() {
    const ehCartao = document.getElementById('novo-lanc-destino').value === 'cartao';
    document.getElementById('div-qual-cartao').style.display = ehCartao ? 'block' : 'none';
    const fx = document.getElementById('div-fixo-cartao');
    if (fx) fx.style.display = ehCartao ? 'flex' : 'none';
}




// Expande/colapsa a lista de gastos fora da janela de uma fatura
function toggleForaJanela(cartaoId) {
    const lista   = document.getElementById('lista-fora-' + cartaoId);
    const chevron = document.getElementById('chevron-fora-' + cartaoId);
    if (!lista) return;
    const aberto = lista.style.display === 'block';
    lista.style.display   = aberto ? 'none'    : 'block';
    if (chevron) chevron.style.transform = aberto ? 'rotate(0deg)' : 'rotate(180deg)';
}

// Colapsa/expande a lista de itens de uma fatura ao clicar no cabeçalho
function toggleColapsarFatura(cartaoId) {
    faturaColapsada[cartaoId] = !faturaColapsada[cartaoId];
    const corpo = document.getElementById('corpo-fatura-' + cartaoId);
    const icone = document.getElementById('icone-colapso-' + cartaoId);
    if (!corpo) return;
    if (faturaColapsada[cartaoId]) {
        corpo.style.display = 'none';
        if (icone) icone.style.transform = 'rotate(-90deg)';
    } else {
        corpo.style.display = 'block';
        if (icone) icone.style.transform = 'rotate(0deg)';
    }
}

// Revela/esconde as ações de um item de fatura ao clicar nele

// Salva data de início OU fechamento de uma fatura (por cartão + mês)
function salvarAbrangenciaFatura(cartaoId, mesAnoAtual, campo, valor) {
    if (!valor) return;
    db_faturas.forEach(function(f) {
        if (f.cartao_id === cartaoId && f.mes_fatura === mesAnoAtual) {
            if (campo === 'inicio')     f.data_inicio   = valor;
            if (campo === 'fechamento') f.fechamento_dia = valor;
        }
    });
    sincronizarFaturas();
}

// Mantido para compatibilidade com código legado
function salvarFechamentoDia(cartaoId, mesAnoAtual, dia) {
    salvarAbrangenciaFatura(cartaoId, mesAnoAtual, 'fechamento', dia);
}


// Filtro por pessoa na fatura — clica no nome para filtrar, clica de novo para limpar
function toggleFiltroPessoa(cartaoId, pessoaId) {
    if (filtroFaturaPessoa[cartaoId] === pessoaId) {
        delete filtroFaturaPessoa[cartaoId]; // Clicou no mesmo: limpa filtro
    } else {
        filtroFaturaPessoa[cartaoId] = pessoaId;
    }
    renderizarApp();
}

function toggleAcoesItem(el) {
    const acoes = el.querySelector('.item-acoes');
    if (!acoes) return;
    const aberto = acoes.style.display === 'flex';
    // Fecha todos os outros itens abertos primeiro
    document.querySelectorAll('.item-acoes').forEach(function(a) { a.style.display = 'none'; });
    acoes.style.display = aberto ? 'none' : 'flex';
}

function processarNovoLancamento() {
    const editId = document.getElementById('edit-fatura-id').value;
    const destino = document.getElementById('novo-lanc-destino').value;
    const cartaoId = document.getElementById('novo-lanc-cartao-id').value;
    const desc = document.getElementById('novo-lanc-desc').value.trim();
    const dataStr = document.getElementById('novo-lanc-data').value;
    const valorTotal = parseFloat(document.getElementById('novo-lanc-valor').value);
    const catId = document.getElementById('novo-lanc-cat').value;
    const subCatId = document.getElementById('novo-lanc-subcat').value;
    const selectsDonos = document.querySelectorAll('.select-dono');
    const qtdPessoas = selectsDonos.length;

    // Validação: todos os campos obrigatórios
    const catId_check = document.getElementById('novo-lanc-cat').value;
    const erros = [];
    if (!desc)              erros.push('• Descrição da compra');
    if (!dataStr)           erros.push('• Data');
    if (isNaN(valorTotal) || valorTotal <= 0) erros.push('• Valor (deve ser maior que zero)');
    if (!catId_check)       erros.push('• Categoria');
    if (qtdPessoas === 0)   erros.push('• Pelo menos uma pessoa na dívida');
    if (erros.length > 0) return alert('Preencha os campos obrigatórios:\n' + erros.join('\n'));

    // ---- DESTINO: GASTO PONTUAL (Dinheiro/Pix) ----
    if (destino === 'pontual') {
        const mesRef = dataStr.substring(0, 7); // YYYY-MM
        const inputsValor = document.querySelectorAll('.input-valor-dono');
        const divisao = Array.from(selectsDonos).map(function(sel, i) {
            const v = inputsValor[i] ? parseFloat(inputsValor[i].value) : (valorTotal / qtdPessoas);
            return { pessoa_id: sel.value, valor: isNaN(v) ? (valorTotal / qtdPessoas) : v };
        });
        if (editId) {
            // EDITAR gasto pontual existente
            const g = db_gastos_pontuais.find(function(x) { return x.id === editId; });
            if (g) {
                g.desc = desc; g.valor = valorTotal; g.data = dataStr;
                g.cat_id = catId; g.subcat_id = subCatId;
                g.divisao = divisao; g.valor_editado = true;
                sincronizarGastosPontuais();
            }
        } else {
            // NOVO gasto pontual avulso
            db_gastos_pontuais.push({
                id: 'gp_' + Date.now(),
                desc: desc, valor: valorTotal, data: dataStr, mes_ref: mesRef,
                cat_id: catId, subcat_id: subCatId, divisao: divisao,
                origem_regra: null, valor_editado: false
            });
            sincronizarGastosPontuais();
        }
        fecharModalLancamento();
        return;
    }

    // ---- DESTINO: CARTAO DE CREDITO ----
    if (editId) {
        // MODO EDIÇÃO de fatura
        const fatura = db_faturas.find(function(f) { return f.id === editId; });
        if (fatura) {
            fatura.desc = desc;
            fatura.valor_parcela = valorTotal;
            fatura.cartao_id = cartaoId;
            fatura.data_compra = dataStr;
            fatura.cat_id = catId;
            fatura.subcat_id = subCatId;
            fatura.fixo = document.getElementById('novo-lanc-fixo').checked;

            // Recalcula mes_fatura com base na nova data e no dia de fechamento do cartão
            const novaDataCompra = new Date(dataStr + 'T12:00:00');
            fatura.mes_fatura = calcularMesFatura(novaDataCompra, cartaoId);

            fatura.divisao = [];
            const inputsValorEd = document.querySelectorAll('.input-valor-dono');
            selectsDonos.forEach(function(sel, i) {
                const v = inputsValorEd[i] ? parseFloat(inputsValorEd[i].value) : (valorTotal / qtdPessoas);
                fatura.divisao.push({ pessoa_id: sel.value, valor: isNaN(v) ? (valorTotal / qtdPessoas) : v });
            });
            sincronizarFaturas();
        }
    } else {
        // MODO NOVO LANCAMENTO parcelado
        const parcelas = parseInt(document.getElementById('novo-lanc-parcelas').value) || 1;
        const dataCompra = new Date(dataStr + 'T12:00:00');
        const idCompraPai = 'compra_' + Date.now();

        // Mês da 1ª parcela: calculado de forma determinística a partir do
        // dia de fechamento cadastrado no cartão (veja calcularMesFatura).
        // As parcelas seguintes simplesmente avançam um mês cada uma.
        const mesBaseFatura = calcularMesFatura(dataCompra, cartaoId);

        for (let i = 0; i < parcelas; i++) {
            const mesF = somarMesesAMesFatura(mesBaseFatura, i);
            const divisao = [];
            const inputsValorP = document.querySelectorAll('.input-valor-dono');
            selectsDonos.forEach(function(sel, idx) {
                const v = inputsValorP[idx] ? parseFloat(inputsValorP[idx].value) : ((valorTotal/parcelas) / qtdPessoas);
                divisao.push({ pessoa_id: sel.value, valor: isNaN(v) ? ((valorTotal/parcelas) / qtdPessoas) : v });
            });
            db_faturas.push({ id: 'fat_' + Date.now() + '_' + i, id_compra_pai: idCompraPai, cartao_id: cartaoId, desc: desc, data_compra: dataStr, mes_fatura: mesF, valor_parcela: valorTotal / parcelas, parcela_atual: i + 1, total_parcelas: parcelas, cat_id: catId, subcat_id: subCatId, divisao: divisao, fechamento_dia: '', fixo: document.getElementById('novo-lanc-fixo').checked });
        }
        sincronizarFaturas();
    }
    fecharModalLancamento();
}

// ==============================================================
// EDIÇÃO COMPLETA DE PARCELAMENTOS
// Mostra todos os lançamentos futuros com edição individual
// ==============================================================


// ==============================================================
// EDIÇÃO COMPLETA DE PARCELAMENTOS — painel geral + prévia
// ==============================================================

let _mepState = {
    parcelas: [],   // cópia das parcelas com edições
    tipo: null,     // 'fatura' ou 'pontual'
    totalRef: 0,    // total de referência (soma original)
    sobrescrito: {} // { id: true } — parcelas editadas individualmente
};

function _mepFechar() {
    const m = document.getElementById('modal-editar-parcelas');
    if (m) m.remove();
}

// ── Construtor do modal unificado ─────────────────────────

function _mepCriarModal(tipo, id) {
    // Coleta parcelas
    let parcelasOriginais = [];
    if (tipo === 'fatura') {
        const fat = db_faturas.find(function(f) { return f.id === id; });
        if (!fat) return;
        parcelasOriginais = db_faturas
            .filter(function(f) { return f.id_compra_pai === fat.id_compra_pai; })
            .sort(function(a, b) { return a.parcela_atual - b.parcela_atual; });
    } else {
        const g = db_gastos_pontuais.find(function(x) { return x.id === id; });
        if (!g) return;
        parcelasOriginais = db_gastos_pontuais
            .filter(function(x) { return x.id_grupo === g.id_grupo; })
            .sort(function(a, b) { return a.parcela_num - b.parcela_num; });
    }

    const totalRef = parcelasOriginais.reduce(function(s, p) {
        return s + (tipo === 'fatura' ? p.valor_parcela : p.valor);
    }, 0);

    // Estado global
    _mepState = {
        parcelas: parcelasOriginais.map(function(p) {
            return Object.assign({}, p, {
                _valor: tipo === 'fatura' ? p.valor_parcela : p.valor,
                _desc:  p.desc
            });
        }),
        tipo: tipo,
        totalRef: totalRef,
        sobrescrito: {}
    };

    _mepFechar();

    const ref  = parcelasOriginais[0];
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    // Divisão inicial para o painel geral
    const divisaoInicial = (tipo === 'fatura' ? ref.divisao : ref.divisao) || [];
    const principal = db_pessoas.find(function(p) { return p.tipo === 'principal'; });

    const overlay = document.createElement('div');
    overlay.id = 'modal-editar-parcelas';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.78);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) _mepFechar(); });

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface);border:1px solid var(--w-13);border-radius:20px;width:96%;max-width:620px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 28px 90px rgba(0,0,0,0.9);overflow:hidden;';

    // ── Cabeçalho ────────────────────────────────────────────
    const header = document.createElement('div');
    header.style.cssText = 'padding:18px 22px 14px;border-bottom:1px solid var(--w-08);flex-shrink:0;display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML =
        '<div>' +
        '<h3 style="color:var(--primary);margin:0 0 3px;font-size:16px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar Parcelamento</h3>' +
        '<div style="font-size:11px;color:var(--text-muted);">' + parcelasOriginais.length + 'x &bull; Total original: ' + formatarMoeda(totalRef) + '</div>' +
        '</div>' +
        '<button id="mep-x" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:20px;line-height:1;"><svg class="ic"><use href="#i-x"/></svg></button>';

    // ── Corpo scrollável ──────────────────────────────────────
    const corpo = document.createElement('div');
    corpo.style.cssText = 'overflow-y:auto;flex:1;padding:18px 22px;display:flex;flex-direction:column;gap:16px;';

    // SEÇÃO 1: PAINEL GERAL
    const secGeral = document.createElement('div');
    secGeral.innerHTML =
        '<div style="font-size:10px;font-weight:700;color:var(--info);letter-spacing:0.7px;margin-bottom:10px;"><svg class="ic ic-t"><use href="#i-cfg"/></svg>Painel Geral — aplica em todas as parcelas</div>';

    // Linha 1: Descrição
    const l1 = document.createElement('div');
    l1.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    l1.innerHTML = '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;">DESCRIÇÃO</label>';
    const inpDesc = document.createElement('input');
    inpDesc.type = 'text'; inpDesc.id = 'mep-g-desc';
    inpDesc.className = 'form-control'; inpDesc.value = ref.desc;
    inpDesc.placeholder = 'Descrição da compra';
    inpDesc.addEventListener('input', _mepAtualizarGeral);
    l1.appendChild(inpDesc);
    secGeral.appendChild(l1);

    // Linha 2: Valor total + Cartão (se fatura)
    const l2 = document.createElement('div');
    l2.style.cssText = 'display:flex;gap:10px;';

    const divValor = document.createElement('div');
    divValor.style.flex = '2';
    divValor.innerHTML = '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px;">VALOR TOTAL R$</label>';
    const inpValor = document.createElement('input');
    inpValor.type = 'number'; inpValor.step = '0.01'; inpValor.id = 'mep-g-valor';
    inpValor.className = 'form-control'; inpValor.value = totalRef.toFixed(2);
    inpValor.addEventListener('input', _mepAtualizarGeral);
    divValor.appendChild(inpValor);
    l2.appendChild(divValor);

    if (tipo === 'fatura') {
        const divCartao = document.createElement('div');
        divCartao.style.flex = '2';
        divCartao.innerHTML = '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px;">CARTÃO</label>';
        const selCartao = document.createElement('select');
        selCartao.id = 'mep-g-cartao'; selCartao.className = 'form-control';
        db_cartoes.forEach(function(c) {
            const opt = document.createElement('option');
            opt.value = c.id; opt.textContent = c.nome;
            if (c.id === ref.cartao_id) opt.selected = true;
            selCartao.appendChild(opt);
        });
        divCartao.appendChild(selCartao);
        l2.appendChild(divCartao);
    }
    secGeral.appendChild(l2);

    // Linha 3: Categoria + Sub
    const l3 = document.createElement('div');
    l3.style.cssText = 'display:flex;gap:10px;';
    const divCat = document.createElement('div'); divCat.style.flex = '1';
    divCat.innerHTML = '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px;">CATEGORIA</label>';
    const selCat = document.createElement('select'); selCat.id = 'mep-g-cat'; selCat.className = 'form-control';
    db_categorias.forEach(function(c) {
        const opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.nome;
        if (c.id === ref.cat_id) opt.selected = true;
        selCat.appendChild(opt);
    });
    selCat.addEventListener('change', function() {
        const sub = document.getElementById('mep-g-sub'); if (!sub) return;
        const cat = db_categorias.find(function(c) { return c.id === selCat.value; });
        sub.innerHTML = (cat && cat.subcategorias.length > 0)
            ? cat.subcategorias.map(function(s) { return '<option value="' + s.id + '">' + s.nome + '</option>'; }).join('')
            : '<option value="">Sem subcategorias</option>';
    });
    divCat.appendChild(selCat); l3.appendChild(divCat);

    const divSub = document.createElement('div'); divSub.style.flex = '1';
    divSub.innerHTML = '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px;">SUBCATEGORIA</label>';
    const selSub = document.createElement('select'); selSub.id = 'mep-g-sub'; selSub.className = 'form-control';
    const catRef = db_categorias.find(function(c) { return c.id === ref.cat_id; });
    if (catRef && catRef.subcategorias.length > 0) {
        catRef.subcategorias.forEach(function(s) {
            const opt = document.createElement('option');
            opt.value = s.id; opt.textContent = s.nome;
            if (s.id === ref.subcat_id) opt.selected = true;
            selSub.appendChild(opt);
        });
    } else {
        selSub.innerHTML = '<option value="">Sem subcategorias</option>';
    }
    divSub.appendChild(selSub); l3.appendChild(divSub);
    secGeral.appendChild(l3);

    // Linha 4: Divisão por pessoa
    const divDono = document.createElement('div');
    divDono.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
        '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;">DE QUEM É?</label>' +
        '<button id="mep-add-dono" style="background:var(--accent);color:var(--on-accent);border:none;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;cursor:pointer;">+ Pessoa</button></div>' +
        '<div id="mep-donos" style="display:flex;flex-direction:column;gap:6px;"></div>';
    secGeral.appendChild(divDono);
    corpo.appendChild(secGeral);

    // DIVISOR
    const divider = document.createElement('div');
    divider.style.cssText = 'border-top:1px solid var(--w-08);margin:0 -22px;padding:0 22px;';
    divider.innerHTML = '<div style="font-size:10px;font-weight:700;color:var(--warning);letter-spacing:0.7px;padding:10px 0 2px;"><svg class="ic ic-t"><use href="#i-orc"/></svg>Prévia das Parcelas — edite individualmente se quiser</div>';
    corpo.appendChild(divider);

    // SEÇÃO 2: PRÉVIA DAS PARCELAS
    const secPrev = document.createElement('div');
    secPrev.id = 'mep-preview';
    secPrev.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    corpo.appendChild(secPrev);

    // VALIDADOR TOTAL
    const validador = document.createElement('div');
    validador.id = 'mep-validador';
    validador.style.cssText = 'background:var(--k-25);border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;';
    validador.innerHTML =
        '<span style="font-size:11px;color:var(--text-muted);">Soma das parcelas</span>' +
        '<div><span id="mep-soma-val" style="font-size:15px;font-weight:800;color:var(--success);">' + formatarMoeda(totalRef) + '</span>' +
        ' <span id="mep-soma-ref" style="font-size:11px;color:var(--text-muted);">/ ' + formatarMoeda(totalRef) + '</span></div>';
    corpo.appendChild(validador);

    const aviso = document.createElement('div');
    aviso.id = 'mep-aviso';
    aviso.style.cssText = 'display:none;font-size:11px;color:var(--danger);padding:6px 10px;background:color-mix(in srgb, var(--danger) 10%, transparent);border-radius:6px;';
    aviso.textContent = 'A soma das parcelas ultrapassa o novo total!';
    corpo.appendChild(aviso);

    // ── Rodapé ────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.style.cssText = 'padding:14px 22px;border-top:1px solid var(--w-08);display:flex;gap:10px;flex-shrink:0;';
    const btnCancelar = document.createElement('button');
    btnCancelar.style.cssText = 'flex:1;background:var(--w-06);border:1px solid var(--w-12);color:var(--text-muted);border-radius:10px;padding:12px;cursor:pointer;font-weight:600;';
    btnCancelar.textContent = 'Cancelar';
    const btnSalvar = document.createElement('button');
    btnSalvar.id = 'mep-btn-salvar';
    btnSalvar.style.cssText = 'flex:2;background:var(--accent);color:var(--on-accent);border:none;border-radius:10px;padding:12px;cursor:pointer;font-weight:700;font-size:14px;';
    btnSalvar.textContent = 'Salvar todas as alterações';
    footer.appendChild(btnCancelar); footer.appendChild(btnSalvar);

    box.appendChild(header); box.appendChild(corpo); box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // ── Eventos ───────────────────────────────────────────────
    box.querySelector('#mep-x').addEventListener('click', _mepFechar);
    btnCancelar.addEventListener('click', _mepFechar);
    btnSalvar.addEventListener('click', function() {
        if (tipo === 'fatura') _mepSalvarFatura(parcelasOriginais, overlay);
        else _mepSalvarPontual(parcelasOriginais, overlay);
    });
    box.querySelector('#mep-add-dono').addEventListener('click', function() {
        _mepAdicionarDono(divisaoInicial.length > 0 ? null : (principal ? principal.id : ''));
    });

    // Inicializar donos
    divisaoInicial.forEach(function(d) { _mepAdicionarDono(d.pessoa_id, d.valor); });

    // Renderizar prévia inicial
    _mepRenderizarPrevia(meses, tipo);
}

// ── Adicionar pessoa na divisão geral ─────────────────────

function _mepAdicionarDono(pessoaId, valor) {
    const container = document.getElementById('mep-donos');
    if (!container) return;
    const opts = db_pessoas.map(function(p) {
        return '<option value="' + p.id + '"' + (pessoaId === p.id ? ' selected' : '') + '>' + p.nome + '</option>';
    }).join('');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;';
    const sel = document.createElement('select'); sel.className = 'form-control mep-g-sel-dono'; sel.style.flex = '1';
    sel.innerHTML = opts;
    sel.addEventListener('change', _mepAtualizarGeral);
    const inp = document.createElement('input'); inp.type = 'number'; inp.step = '0.01';
    inp.className = 'input-quick mep-g-val-dono'; inp.style.width = '90px';
    inp.placeholder = 'R$';
    if (valor !== undefined) inp.value = Number(valor).toFixed(2);
    inp.addEventListener('input', _mepAtualizarGeral);
    const btn = document.createElement('button');
    btn.style.cssText = 'background:var(--danger-bg);color:white;border:none;border-radius:8px;width:36px;height:44px;cursor:pointer;font-size:16px;flex-shrink:0;';
    btn.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    btn.addEventListener('click', function() { row.remove(); _mepAtualizarGeral(); });
    row.appendChild(sel); row.appendChild(inp); row.appendChild(btn);
    container.appendChild(row);
}

// ── Atualiza prévia quando painel geral muda ───────────────

function _mepAtualizarGeral() {
    const novoValorTotal = parseFloat(document.getElementById('mep-g-valor').value) || _mepState.totalRef;
    const novaDesc       = document.getElementById('mep-g-desc').value;
    const n = _mepState.parcelas.length;
    const valorPorParcela = novoValorTotal / n;

    // Redistribui proporcionalmente nas parcelas não sobrescritas manualmente
    const sobrescritasTotal = Object.keys(_mepState.sobrescrito)
        .reduce(function(s, id) {
            const p = _mepState.parcelas.find(function(x) { return x.id === id; });
            return s + (p ? p._valor : 0);
        }, 0);
    const livres = _mepState.parcelas.filter(function(p) { return !_mepState.sobrescrito[p.id]; });
    const valorParaLivres = novoValorTotal - sobrescritasTotal;
    const valorCadaLivre  = livres.length > 0 ? valorParaLivres / livres.length : 0;

    _mepState.parcelas.forEach(function(p) {
        if (!_mepState.sobrescrito[p.id]) p._valor = Math.max(0, valorCadaLivre);
        if (!_mepState.sobrescrito[p.id + '_desc']) p._desc = novaDesc;
    });

    // Atualizar referência do total no validador
    const refEl = document.getElementById('mep-soma-ref');
    if (refEl) refEl.textContent = '/ ' + formatarMoeda(novoValorTotal);

    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    _mepRenderizarPrevia(meses, _mepState.tipo);
}

// ── Renderiza a prévia de parcelas ─────────────────────────

function _mepRenderizarPrevia(meses, tipo) {
    const sec = document.getElementById('mep-preview');
    if (!sec) return;
    sec.innerHTML = '';

    _mepState.parcelas.forEach(function(p) {
        const mesArr = (tipo === 'fatura' ? p.mes_fatura : p.mes_ref).split('-');
        const nomeMes = meses[parseInt(mesArr[1]) - 1] + '/' + mesArr[0].slice(2);
        const numParc = tipo === 'fatura' ? p.parcela_atual : p.parcela_num;
        const totalP  = p.total_parcelas;
        const corTag  = tipo === 'fatura' ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--success) 12%, transparent)';
        const corBord = tipo === 'fatura' ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'color-mix(in srgb, var(--success) 25%, transparent)';
        const corTxt  = tipo === 'fatura' ? 'var(--info)' : 'var(--success)';
        const isSob   = _mepState.sobrescrito[p.id] || _mepState.sobrescrito[p.id + '_desc'];

        const row = document.createElement('div');
        row.style.cssText = 'background:var(--w-03);border:1px solid rgba(255,255,255,' + (isSob ? '0.15' : '0.07') + ');border-radius:10px;padding:10px 12px;display:flex;align-items:center;gap:8px;' + (isSob ? 'border-left:3px solid var(--warning);' : '');

        const tag = document.createElement('div');
        tag.style.cssText = 'background:' + corTag + ';border:1px solid ' + corBord + ';border-radius:7px;padding:4px 8px;font-size:11px;font-weight:700;color:' + corTxt + ';white-space:nowrap;flex-shrink:0;text-align:center;min-width:44px;';
        tag.innerHTML = numParc + '/' + totalP + '<br><span style="font-weight:400;font-size:9px;">' + nomeMes + '</span>';

        const descI = document.createElement('input');
        descI.type = 'text'; descI.className = 'form-control';
        descI.value = p._desc; descI.style.cssText = 'flex:1;font-size:12px;padding:8px 10px;';
        descI.addEventListener('input', (function(pid, v) { return function() {
            const pp = _mepState.parcelas.find(function(x) { return x.id === pid; });
            if (pp) { pp._desc = this.value; _mepState.sobrescrito[pid + '_desc'] = true; }
            _mepRecalcularSoma();
        }; })(p.id));

        const valI = document.createElement('input');
        valI.type = 'number'; valI.step = '0.01';
        valI.className = 'input-quick'; valI.style.cssText = 'width:90px;';
        valI.value = p._valor.toFixed(2);
        valI.addEventListener('input', (function(pid) { return function() {
            const pp = _mepState.parcelas.find(function(x) { return x.id === pid; });
            if (pp) { pp._valor = parseFloat(this.value) || 0; _mepState.sobrescrito[pid] = true; }
            _mepRecalcularSoma();
        }; })(p.id));

        row.appendChild(tag); row.appendChild(descI); row.appendChild(valI);
        sec.appendChild(row);
    });

    _mepRecalcularSoma();
}

function _mepRecalcularSoma() {
    const soma = _mepState.parcelas.reduce(function(s, p) { return s + p._valor; }, 0);
    const novoTotal = parseFloat((document.getElementById('mep-g-valor') || {}).value) || _mepState.totalRef;
    const somaEl  = document.getElementById('mep-soma-val');
    const avisoEl = document.getElementById('mep-aviso');
    const salvarEl = document.getElementById('mep-btn-salvar');
    const ultrapassou = soma > novoTotal + 0.01;
    if (somaEl) { somaEl.textContent = formatarMoeda(soma); somaEl.style.color = ultrapassou ? 'var(--danger)' : 'var(--success)'; }
    if (avisoEl) avisoEl.style.display = ultrapassou ? 'block' : 'none';
    if (salvarEl) { salvarEl.disabled = ultrapassou; salvarEl.style.opacity = ultrapassou ? '0.4' : '1'; }
}

// ── Salvar ─────────────────────────────────────────────────

function _mepSalvarFatura(parcelasOriginais, overlay) {
    const novaDesc  = document.getElementById('mep-g-desc').value.trim();
    const novaCat   = document.getElementById('mep-g-cat').value;
    const novaSub   = document.getElementById('mep-g-sub').value;
    const novoCartao= (document.getElementById('mep-g-cartao') || {}).value;
    const selsDono  = document.querySelectorAll('.mep-g-sel-dono');
    const valsDono  = document.querySelectorAll('.mep-g-val-dono');

    _mepState.parcelas.forEach(function(p) {
        const fat = db_faturas.find(function(f) { return f.id === p.id; });
        if (!fat) return;
        fat.desc       = p._desc || novaDesc;
        fat.cat_id     = novaCat;
        fat.subcat_id  = novaSub;
        if (novoCartao) fat.cartao_id = novoCartao;
        fat.valor_parcela = p._valor;
        // Redistribui divisão proporcionalmente
        const fator = fat.valor_parcela > 0 ? p._valor / (fat.valor_parcela || p._valor) : 1;
        if (selsDono.length > 0) {
            fat.divisao = Array.from(selsDono).map(function(sel, i) {
                const v = valsDono[i] ? (parseFloat(valsDono[i].value) / _mepState.parcelas.length) : (p._valor / selsDono.length);
                return { pessoa_id: sel.value, valor: v };
            });
        } else {
            fat.divisao.forEach(function(d) { d.valor = Math.round(d.valor * fator * 100) / 100; });
        }
    });
    overlay.remove();
    sincronizarFaturas();
}

function _mepSalvarPontual(parcelasOriginais, overlay) {
    const novaDesc = document.getElementById('mep-g-desc').value.trim();
    const novaCat  = document.getElementById('mep-g-cat').value;
    const novaSub  = document.getElementById('mep-g-sub').value;
    const selsDono = document.querySelectorAll('.mep-g-sel-dono');
    const valsDono = document.querySelectorAll('.mep-g-val-dono');

    _mepState.parcelas.forEach(function(p) {
        const gasto = db_gastos_pontuais.find(function(x) { return x.id === p.id; });
        if (!gasto) return;
        gasto.desc     = p._desc || novaDesc;
        gasto.cat_id   = novaCat;
        gasto.subcat_id = novaSub;
        const fator = gasto.valor > 0 ? p._valor / gasto.valor : 1;
        gasto.valor    = p._valor;
        gasto.valor_editado = true;
        if (selsDono.length > 0) {
            gasto.divisao = Array.from(selsDono).map(function(sel, i) {
                const v = valsDono[i] ? (parseFloat(valsDono[i].value) / _mepState.parcelas.length) : (p._valor / selsDono.length);
                return { pessoa_id: sel.value, valor: v };
            });
        } else {
            gasto.divisao.forEach(function(d) { d.valor = Math.round(d.valor * fator * 100) / 100; });
        }
    });
    overlay.remove();
    sincronizarGastosPontuais();
}

// ── Entrypoints ────────────────────────────────────────────


// ==== ESTORNO DE FATURA ====

function abrirEstorno(cartaoId, mesAnoAtual) {
    const cartao = db_cartoes.find(function(c) { return c.id === cartaoId; });
    if (!cartao) return;
    const ant = document.getElementById('modal-estorno');
    if (ant) ant.remove();
    const principal = db_pessoas.find(function(p) { return p.tipo === 'principal'; });
    const overlay = document.createElement('div');
    overlay.id = 'modal-estorno';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface);border:1px solid var(--w-13);border-radius:18px;width:92%;max-width:400px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,0.9);display:flex;flex-direction:column;gap:14px;';
    box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<h3 style="color:var(--success);margin:0;font-size:16px;"><svg class="ic ic-t"><use href="#i-undo"/></svg>Lan&#xE7;ar Estorno</h3>' +
        '<button id="est-fechar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:20px;line-height:1;"><svg class="ic"><use href="#i-x"/></svg></button></div>' +
        '<div style="font-size:11px;color:var(--text-muted);padding:8px 12px;background:color-mix(in srgb, var(--success) 7%, transparent);border-radius:8px;border:1px solid color-mix(in srgb, var(--success) 20%, transparent);">O estorno ser&#xE1; subtra&#xED;do do total da fatura do <strong style="color:var(--text-main);">' + cartao.nome + '</strong>. Aparece como linha verde na fatura.</div>' +
        '<div><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:5px;">DESCRI&#xC7;&#xC3;O</label>' +
        '<input id="est-desc" type="text" class="form-control" placeholder="Ex: Estorno compra Amazon"></div>' +
        '<div style="display:flex;gap:10px;">' +
        '<div style="flex:1;"><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:5px;">VALOR R$</label>' +
        '<input id="est-valor" type="number" step="0.01" class="form-control" placeholder="0.00"></div>' +
        '<div style="flex:1;"><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:5px;">DATA</label>' +
        '<input id="est-data" type="date" class="form-control"></div></div>' +
        '<div style="display:flex;gap:10px;">' +
        '<button id="est-cancelar" style="flex:1;background:var(--w-06);border:1px solid var(--w-12);color:var(--text-muted);border-radius:10px;padding:12px;cursor:pointer;font-weight:600;">Cancelar</button>' +
        '<button id="est-salvar" style="flex:2;background:linear-gradient(135deg,color-mix(in srgb, var(--success) 85%, transparent),rgba(32,170,65,0.85));color:#fff;border:1px solid color-mix(in srgb, var(--success) 40%, transparent);border-radius:10px;padding:12px;cursor:pointer;font-weight:700;font-size:14px;">Lan&#xE7;ar Estorno</button>' +
        '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const hoje = new Date();
    document.getElementById('est-data').value = hoje.getFullYear() + '-' + String(hoje.getMonth()+1).padStart(2,'0') + '-' + String(hoje.getDate()).padStart(2,'0');
    box.querySelector('#est-fechar').addEventListener('click',   function() { overlay.remove(); });
    box.querySelector('#est-cancelar').addEventListener('click', function() { overlay.remove(); });
    box.querySelector('#est-salvar').addEventListener('click', function() {
        const desc  = document.getElementById('est-desc').value.trim();
        const valor = parseFloat(document.getElementById('est-valor').value);
        const data  = document.getElementById('est-data').value;
        if (!desc)              { alert('Preencha a descrição!'); return; }
        if (isNaN(valor) || valor <= 0) { alert('Informe o valor do estorno!'); return; }
        if (!data)              { alert('Informe a data!'); return; }
        const divisao = principal ? [{ pessoa_id: principal.id, valor: -valor }] : [];
        const novoId = 'est_' + Date.now();
        db_faturas.push({
            id: novoId, id_compra_pai: novoId, cartao_id: cartaoId,
            desc: desc, data_compra: data, mes_fatura: mesAnoAtual,
            valor_parcela: -valor, parcela_atual: 1, total_parcelas: 1,
            cat_id: null, subcat_id: null, divisao: divisao,
            fechamento_dia: '', data_inicio: ''
        });
        overlay.remove();
        sincronizarFaturas();
    });
}

function abrirEdicaoParcelasFatura(id)   { _mepCriarModal('fatura',  id); }
function abrirEdicaoParcelasPontual(id) {
    const g = db_gastos_pontuais.find(function(x) { return x.id === id; });
    if (!g) return;
    if (!g.id_grupo || g.total_parcelas <= 1) { editarGastoPontual(id); return; }

    // Coleta todas as parcelas do grupo ordenadas
    const parcelas = db_gastos_pontuais
        .filter(function(x) { return x.id_grupo === g.id_grupo; })
        .sort(function(a, b) { return a.parcela_num - b.parcela_num; });

    const n = parcelas.length;
    const totalOriginal = parcelas.reduce(function(s, p) { return s + p.valor; }, 0);
    const mesesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

    // Calcula distribuição: divide total igualmente, último absorve arredondamento
    function distribuir(total) {
        const base = Math.floor(total / n * 100) / 100;
        const vals = parcelas.map(function() { return base; });
        const diff = Math.round((total - base * n) * 100) / 100;
        vals[vals.length - 1] = Math.round((base + diff) * 100) / 100;
        return vals;
    }

    // Calcula datas das parcelas a partir de uma data inicial
    function calcDatas(dataBase) {
        return parcelas.map(function(p, i) {
            const d = new Date(dataBase + 'T12:00:00');
            const m = new Date(d.getFullYear(), d.getMonth() + i, d.getDate());
            return m.getFullYear() + '-' + String(m.getMonth()+1).padStart(2,'0') + '-' + String(m.getDate()).padStart(2,'0');
        });
    }

    const ant = document.getElementById('modal-editar-pont-parc');
    if (ant) ant.remove();

    const overlay = document.createElement('div');
    overlay.id = 'modal-editar-pont-parc';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.78);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface);border:1px solid var(--w-13);border-radius:20px;width:96%;max-width:520px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 28px 90px rgba(0,0,0,0.9);overflow:hidden;';

    // Cabeçalho
    const header = document.createElement('div');
    header.style.cssText = 'padding:18px 22px 14px;border-bottom:1px solid var(--w-08);flex-shrink:0;display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML =
        '<div><h3 style="color:var(--primary);margin:0 0 3px;font-size:16px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar Parcelamento</h3>' +
        '<div style="font-size:11px;color:var(--text-muted);">' + n + 'x &bull; Total original: ' + formatarMoeda(totalOriginal) + '</div></div>' +
        '<button id="gpe-fechar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:20px;line-height:1;"><svg class="ic"><use href="#i-x"/></svg></button>';

    // Corpo scrollável
    const corpo = document.createElement('div');
    corpo.style.cssText = 'overflow-y:auto;flex:1;padding:18px 22px;display:flex;flex-direction:column;gap:12px;';

    // Formulário geral
    const secGeral = document.createElement('div');
    secGeral.style.cssText = 'background:var(--w-03);border:1px solid var(--w-08);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;';
    secGeral.innerHTML = '<div style="font-size:10px;font-weight:700;color:var(--info);letter-spacing:0.7px;">Informações da Compra</div>';

    // Descrição
    const r1 = document.createElement('div');
    r1.innerHTML = '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px;">DESCRIÇÃO</label>';
    const inpDesc = document.createElement('input');
    inpDesc.type = 'text'; inpDesc.id = 'gpe-desc'; inpDesc.className = 'form-control';
    inpDesc.value = g.desc; inpDesc.placeholder = 'Descrição';
    inpDesc.addEventListener('input', atualizarPreviaGP);
    r1.appendChild(inpDesc);
    secGeral.appendChild(r1);

    // Data + Valor total
    const r2 = document.createElement('div');
    r2.style.cssText = 'display:flex;gap:10px;';

    const dData = document.createElement('div'); dData.style.flex = '1';
    dData.innerHTML = '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px;">DATA 1º PAGAMENTO</label>';
    const inpData = document.createElement('input');
    inpData.type = 'date'; inpData.id = 'gpe-data'; inpData.className = 'form-control';
    inpData.value = parcelas[0].data;
    inpData.addEventListener('change', atualizarPreviaGP);
    dData.appendChild(inpData); r2.appendChild(dData);

    const dValor = document.createElement('div'); dValor.style.flex = '1';
    dValor.innerHTML = '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:4px;">VALOR TOTAL DA COMPRA</label>';
    const inpTotal = document.createElement('input');
    inpTotal.type = 'number'; inpTotal.step = '0.01'; inpTotal.id = 'gpe-total';
    inpTotal.className = 'form-control'; inpTotal.value = totalOriginal.toFixed(2);
    inpTotal.addEventListener('input', atualizarPreviaGP);
    dValor.appendChild(inpTotal); r2.appendChild(dValor);
    secGeral.appendChild(r2);

    // Info: parcelas e valor unitário
    const infoParc = document.createElement('div');
    infoParc.style.cssText = 'display:flex;gap:10px;';
    infoParc.innerHTML =
        '<div style="flex:1;background:var(--k-20);border-radius:8px;padding:8px 12px;text-align:center;">' +
        '<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">Nº de Parcelas</div>' +
        '<input type="number" id="gpe-n-parc" min="1" max="60" value="' + n + '" ' +
        'style="background:var(--w-08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:var(--primary);font-size:18px;font-weight:700;width:70px;text-align:center;padding:4px;" ' +
        'oninput="atualizarPreviaGP()"></div>' +
        '<div style="flex:1;background:var(--k-20);border-radius:8px;padding:8px 12px;text-align:center;">' +
        '<div style="font-size:10px;color:var(--text-muted);">Valor por Parcela</div>' +
        '<div id="gpe-val-parc" style="font-size:16px;font-weight:700;color:var(--success);">' + formatarMoeda(totalOriginal / n) + '</div></div>';
    secGeral.appendChild(infoParc);
    corpo.appendChild(secGeral);

    // Divisor
    const div = document.createElement('div');
    div.innerHTML = '<div style="font-size:10px;font-weight:700;color:var(--warning);letter-spacing:0.7px;"><svg class="ic ic-t"><use href="#i-clipboard"/></svg>Prévia das Parcelas</div>';
    corpo.appendChild(div);

    // Área da prévia
    const preview = document.createElement('div');
    preview.id = 'gpe-preview';
    preview.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    corpo.appendChild(preview);

    // Rodapé
    const footer = document.createElement('div');
    footer.style.cssText = 'padding:14px 22px;border-top:1px solid var(--w-08);display:flex;gap:10px;flex-shrink:0;';
    const btnC = document.createElement('button');
    btnC.style.cssText = 'flex:1;background:var(--w-06);border:1px solid var(--w-12);color:var(--text-muted);border-radius:10px;padding:12px;cursor:pointer;font-weight:600;';
    btnC.textContent = 'Cancelar';
    const btnS = document.createElement('button');
    btnS.id = 'gpe-salvar';
    btnS.style.cssText = 'flex:2;background:var(--accent);color:var(--on-accent);border:none;border-radius:10px;padding:12px;cursor:pointer;font-weight:700;font-size:14px;';
    btnS.textContent = 'Salvar Parcelamento';
    footer.appendChild(btnC); footer.appendChild(btnS);

    box.appendChild(header); box.appendChild(corpo); box.appendChild(footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#gpe-fechar').addEventListener('click', function() { overlay.remove(); });
    btnC.addEventListener('click', function() { overlay.remove(); });
    btnS.addEventListener('click', function() {
        const novoTotal = parseFloat(document.getElementById('gpe-total').value) || totalOriginal;
        const novaDesc  = document.getElementById('gpe-desc').value.trim() || g.desc;
        const novaData  = document.getElementById('gpe-data').value || parcelas[0].data;
        const novoN     = Math.max(1, parseInt(document.getElementById('gpe-n-parc').value) || n);

        function distribuirN(total, qtd) {
            const base = Math.floor(total / qtd * 100) / 100;
            const vals = Array(qtd).fill(base);
            const diff = Math.round((total - base * qtd) * 100) / 100;
            vals[vals.length - 1] = Math.round((base + diff) * 100) / 100;
            return vals;
        }
        function calcDatasN(dataBase, qtd) {
            return Array.from({length: qtd}, function(_, i) {
                const d = new Date(dataBase + 'T12:00:00');
                const m = new Date(d.getFullYear(), d.getMonth() + i, d.getDate());
                return m.getFullYear() + '-' + String(m.getMonth()+1).padStart(2,'0') + '-' + String(m.getDate()).padStart(2,'0');
            });
        }

        const vals  = distribuirN(novoTotal, novoN);
        const datas = calcDatasN(novaData, novoN);
        const divisaoRef = parcelas[0].divisao; // referência para novas parcelas

        // Atualizar parcelas existentes
        parcelas.forEach(function(p, i) {
            const gasto = db_gastos_pontuais.find(function(x) { return x.id === p.id; });
            if (!gasto) return;
            if (i < novoN) {
                // Atualiza
                gasto.desc = novaDesc;
                gasto.data = datas[i];
                gasto.mes_ref = datas[i].substring(0, 7);
                const fator = gasto.valor > 0 ? vals[i] / gasto.valor : 1;
                gasto.valor = vals[i];
                gasto.total_parcelas = novoN;
                gasto.valor_editado = true;
                gasto.divisao.forEach(function(d) { d.valor = Math.round(d.valor * fator * 100) / 100; });
            } else {
                // Remove parcela excedente
                db_gastos_pontuais = db_gastos_pontuais.filter(function(x) { return x.id !== p.id; });
            }
        });

        // Criar novas parcelas se novoN > n
        for (let i = n; i < novoN; i++) {
            const fatorDiv = vals[0] > 0 ? vals[i] / vals[0] : 1;
            db_gastos_pontuais.push({
                id:             'gp_' + Date.now() + '_' + i,
                desc:           novaDesc,
                valor:          vals[i],
                data:           datas[i],
                mes_ref:        datas[i].substring(0, 7),
                cat_id:         g.cat_id,
                subcat_id:      g.subcat_id,
                divisao:        divisaoRef.map(function(d) { return { pessoa_id: d.pessoa_id, valor: Math.round(d.valor * fatorDiv * 100) / 100 }; }),
                origem_regra:   null,
                valor_editado:  true,
                pago:           false,
                id_grupo:       g.id_grupo,
                parcela_num:    i + 1,
                total_parcelas: novoN
            });
        }

        // Renumerar todas as parcelas do grupo
        db_gastos_pontuais.filter(function(x) { return x.id_grupo === g.id_grupo; })
            .sort(function(a, b) { return a.parcela_num - b.parcela_num; })
            .forEach(function(x, i) { x.total_parcelas = novoN; });

        overlay.remove();
        sincronizarGastosPontuais();
    });

    // Função de atualização da prévia
    function atualizarPreviaGP() {
        const novoTotal = parseFloat(document.getElementById('gpe-total').value) || totalOriginal;
        const novaDesc  = document.getElementById('gpe-desc').value || g.desc;
        const novaData  = document.getElementById('gpe-data').value || parcelas[0].data;
        const novoN     = Math.max(1, parseInt(document.getElementById('gpe-n-parc').value) || n);

        // Reconstrói array de parcelas se n mudou
        const parcelasVirt = [];
        for (let i = 0; i < novoN; i++) {
            parcelasVirt.push({ parcela_num: i + 1, total_parcelas: novoN });
        }

        // Distribui total pelo novo n
        function distribuirN(total, qtd) {
            const base = Math.floor(total / qtd * 100) / 100;
            const vals = Array(qtd).fill(base);
            const diff = Math.round((total - base * qtd) * 100) / 100;
            vals[vals.length - 1] = Math.round((base + diff) * 100) / 100;
            return vals;
        }
        function calcDatasN(dataBase, qtd) {
            return Array.from({length: qtd}, function(_, i) {
                const d = new Date(dataBase + 'T12:00:00');
                const m = new Date(d.getFullYear(), d.getMonth() + i, d.getDate());
                return m.getFullYear() + '-' + String(m.getMonth()+1).padStart(2,'0') + '-' + String(m.getDate()).padStart(2,'0');
            });
        }

        const vals  = distribuirN(novoTotal, novoN);
        const datas = calcDatasN(novaData, novoN);

        // Atualiza valor por parcela
        const vp = document.getElementById('gpe-val-parc');
        if (vp) vp.textContent = formatarMoeda(novoTotal / novoN);

        // Reconstrói a prévia com novoN parcelas
        const prev = document.getElementById('gpe-preview');
        if (!prev) return;
        prev.innerHTML = '';
        for (let i = 0; i < novoN; i++) {
            const mesArr = datas[i].split('-');
            const nomeMes = mesesNome[parseInt(mesArr[1])-1] + '/' + mesArr[0].slice(2);
            // Indica se é existente ou nova
            const isExistente = i < parcelas.length;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--w-02);border:1px solid rgba(255,255,255,' + (isExistente ? '0.06' : '0.12') + ');border-radius:8px;font-size:12px;' + (isExistente ? '' : 'border-style:dashed;');
            row.innerHTML =
                '<span style="background:color-mix(in srgb, var(--success) 12%, transparent);border:1px solid color-mix(in srgb, var(--success) 25%, transparent);border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;color:var(--success);flex-shrink:0;min-width:38px;text-align:center;">' + (i+1) + '/' + novoN + '</span>' +
                '<span style="flex:1;color:var(--text-muted);">' + nomeMes + (isExistente ? '' : ' <span style="font-size:9px;color:var(--info);">nova</span>') + '</span>' +
                '<span style="color:var(--text-main);">' + novaDesc + '</span>' +
                '<span style="font-weight:700;color:var(--success);flex-shrink:0;">' + formatarMoeda(vals[i]) + '</span>';
            prev.appendChild(row);
        }

        // Linha de total (com novoN parcelas)
        const soma = vals.reduce(function(s, v) { return s + v; }, 0);
        const rowTotal = document.createElement('div');
        rowTotal.style.cssText = 'display:flex;justify-content:space-between;padding:8px 10px;border-top:1px solid var(--w-08);font-size:12px;font-weight:700;';
        rowTotal.innerHTML =
            '<span style="color:var(--text-muted);">Total</span>' +
            '<span style="color:' + (Math.abs(soma - novoTotal) < 0.02 ? 'var(--success)' : 'var(--danger)') + ';">' + formatarMoeda(soma) + ' <svg class="ic"><use href="#i-check"/></svg></span>';
        prev.appendChild(rowTotal);
    }

    // Inicializa a prévia
    atualizarPreviaGP();
}

// Manter compatibilidade com mepAtualizar chamado pelo código antigo
function mepAtualizar(id, campo, valor) {}

function abrirEdicaoFatura(id) {
    const fatura = db_faturas.find(f => f.id === id);
    if (!fatura) return;
    // Se parcelado: abre modal de edição completa com todas as parcelas
    if (fatura.total_parcelas > 1) { abrirEdicaoParcelasFatura(id); return; }
    document.getElementById('modal-titulo').innerHTML = '<svg class="ic ic-t"><use href="#i-edit"/></svg>Editar Lançamento';
    document.getElementById('edit-fatura-id').value = fatura.id;
    document.getElementById('novo-lanc-destino').value = "cartao";
    
    preencherCamposBase();
    
    document.getElementById('novo-lanc-cartao-id').value = fatura.cartao_id;
    document.getElementById('novo-lanc-desc').value = fatura.desc;
    document.getElementById('novo-lanc-data').value = fatura.data_compra;
    document.getElementById('novo-lanc-valor').value = fatura.valor_parcela.toFixed(2);
    document.getElementById('novo-lanc-parcelas').value = fatura.total_parcelas;
    document.getElementById('novo-lanc-parcelas').disabled = true; // Impede alterar qtd de parcelas na edição de 1
    document.getElementById('novo-lanc-fixo').checked = !!fatura.fixo;
    
    document.getElementById('novo-lanc-cat').value = fatura.cat_id;
    atualizarSubcategoriasModal();
    document.getElementById('novo-lanc-subcat').value = fatura.subcat_id;
    
    document.getElementById('container-donos-divida').innerHTML = '';
    fatura.divisao.forEach(function(d) { adicionarDonoDivida(d.pessoa_id, d.valor); });
    
    document.getElementById('modal-lancamento').classList.add('active');
}

// Marca/desmarca uma compra do cartão como "dívida fixa" (todas as parcelas dela juntas).
// Ela passa a aparecer também em Gastos Fixos, mas continua contada só na fatura do cartão.
function alternarFixoFatura(id) {
    const f = db_faturas.find(function(x) { return x.id === id; });
    if (!f) return;
    const novo = !f.fixo;
    db_faturas.forEach(function(x) { if (x.id_compra_pai === f.id_compra_pai) x.fixo = novo; });
    sincronizarFaturas();
    if (window.mostrarAviso) mostrarAviso(novo ? 'Marcada como dívida fixa (aparece em Gastos Fixos).' : 'Removida de Gastos Fixos.', 'ok');
}

function editarValorFatura(id, novoValor) {
    const fatura = db_faturas.find(f => f.id === id);
    if (fatura) {
        const valorNumerico = parseFloat(novoValor);
        if (isNaN(valorNumerico)) return;
        const fator = valorNumerico / fatura.valor_parcela;
        fatura.valor_parcela = valorNumerico;
        fatura.divisao.forEach(d => d.valor *= fator);
        sincronizarFaturas();
    }
}

function deletarFatura(id) {
    salvarSnapshotUndo('excluir item da fatura');
    const fatura = db_faturas.find(function(f) { return f.id === id; });
    if (!fatura) return;

    if (fatura.total_parcelas === 1) {
        // À vista: confirma e exclui direto
        if (confirm('Excluir este lançamento?')) {
            db_faturas = db_faturas.filter(function(f) { return f.id !== id; });
            sincronizarFaturas();
        }
        return;
    }

    // Parcelado: exibe modal com duas opções
    const overlay = document.createElement('div');
    overlay.id = 'modal-deletar-fatura';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;z-index:3000;';
    const todasParcelas = db_faturas.filter(function(f) { return f.id_compra_pai === fatura.id_compra_pai; });
    const futuras = todasParcelas.filter(function(f) { return f.mes_fatura >= fatura.mes_fatura; });
    overlay.innerHTML = `
        <div style="background:var(--sidebar-bg);border:1px solid var(--border);border-radius:16px;padding:25px;width:90%;max-width:380px;box-shadow:0 10px 40px rgba(0,0,0,0.8);">
            <h3 style="color:var(--danger);margin:0 0 10px;">Excluir Parcelamento</h3>
            <p style="font-size:13px;color:var(--text-muted);margin:0 0 20px;">
                <strong style="color:var(--text-main);">${fatura.desc}</strong><br>
                Compra em ${fatura.total_parcelas}x &bull; Parcela ${fatura.parcela_atual} selecionada
            </p>
            <div style="display:flex;flex-direction:column;gap:10px;">
                <button onclick="confirmarDeletarFatura('${fatura.id_compra_pai}', 'todos')"
                    style="background:var(--danger-bg);color:white;border:none;border-radius:10px;padding:14px;cursor:pointer;font-weight:700;font-size:13px;">
                    <svg class="ic ic-t"><use href="#i-trash"/></svg>Apagar todos os lançamentos (${todasParcelas.length} parcelas)
                </button>
                <button onclick="confirmarDeletarFatura('${fatura.id_compra_pai}', 'futuros', '${fatura.mes_fatura}')"
                    style="background:var(--surface-2);color:var(--warning);border:1px solid var(--border);border-radius:10px;padding:14px;cursor:pointer;font-weight:700;font-size:13px;">
                    <svg class="ic ic-t"><use href="#i-next"/></svg>Apagar somente futuros (${futuras.length} parcelas)
                </button>
                <button onclick="document.getElementById('modal-deletar-fatura').remove()"
                    style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:8px;font-size:13px;">
                    Cancelar
                </button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
}

function confirmarDeletarFatura(idCompraPai, modo, mesFaturaRef) {
    if (modo === 'todos') {
        db_faturas = db_faturas.filter(function(f) { return f.id_compra_pai !== idCompraPai; });
    } else {
        // Remove só as parcelas cujo mes_fatura >= mês selecionado
        db_faturas = db_faturas.filter(function(f) {
            return f.id_compra_pai !== idCompraPai || f.mes_fatura < mesFaturaRef;
        });
    }
    document.getElementById('modal-deletar-fatura').remove();
    sincronizarFaturas();
}


// ==== FORMULÁRIO DE ENTRADAS NA SIDEBAR ====

function entInicializarForm() {
    // Preenche a data padrão com hoje
    const dataEl = document.getElementById('ent-av-data');
    if (dataEl && !dataEl.value) {
        const hoje = new Date();
        dataEl.value = hoje.getFullYear() + '-' + String(hoje.getMonth()+1).padStart(2,'0') + '-' + String(hoje.getDate()).padStart(2,'0');
    }
    entRenderizarRegras();
}

function salvarEntradaAvulsa() {
    const desc  = document.getElementById('ent-av-desc').value.trim();
    const valor = parseFloat(document.getElementById('ent-av-valor').value);
    const data  = document.getElementById('ent-av-data').value;
    if (!desc)              return alert('Preencha a descrição!');
    if (isNaN(valor) || valor <= 0) return alert('Preencha um valor válido!');
    if (!data)              return alert('Preencha a data!');
    db.transacoes.push({ id: 'avulsa_' + Date.now(), desc: desc, valor: valor, data: data, origem_regra: null });
    document.getElementById('ent-av-desc').value  = '';
    document.getElementById('ent-av-valor').value = '';
    sincronizar();
}

function salvarEntradaRecorrente() {
    const desc  = document.getElementById('ent-rec-desc').value.trim();
    const valor = parseFloat(document.getElementById('ent-rec-valor').value);
    const dia   = document.getElementById('ent-rec-dia').value || '01';
    if (!desc)              return alert('Preencha a descrição!');
    if (isNaN(valor) || valor <= 0) return alert('Preencha um valor válido!');
    const mesCriacao = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth()+1).padStart(2,'0');
    db.regras_fixas.push({ id: 'regra_' + Date.now(), desc: desc, valor: valor, dia: dia, inicio: mesCriacao });
    document.getElementById('ent-rec-desc').value  = '';
    document.getElementById('ent-rec-valor').value = '';
    sincronizar();
    entRenderizarRegras();
}


// Renderiza a lista de regras fixas vigentes na sidebar de entradas
function entRenderizarRegras() {
    const lista = document.getElementById('ent-lista-regras');
    if (!lista) return;
    if (db.regras_fixas.length === 0) {
        lista.innerHTML = '<p style="font-size:11px;color:var(--text-muted);">Nenhuma regra cadastrada.</p>';
        return;
    }
    lista.innerHTML = db.regras_fixas.map(function(r) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;' +
               'background:var(--w-03);border:1px solid var(--w-08);' +
               'border-radius:10px;padding:10px 12px;">' +
               '<div>' +
               '<div style="font-size:13px;font-weight:600;color:var(--text-main);"><svg class="ic ic-t"><use href="#i-fixos"/></svg>' + r.desc + '</div>' +
               '<div style="font-size:11px;color:var(--text-muted);">' + formatarMoeda(r.valor) + ' &bull; Dia ' + r.dia + '</div>' +
               '</div>' +
               '<div style="display:flex;gap:6px;">' +
               '<button onclick="entAbrirEdicaoRegra(\'' + r.id + '\')" ' +
               'style="background:none;border:1px solid var(--w-12);color:var(--info);' +
               'border-radius:7px;padding:4px 9px;cursor:pointer;font-size:11px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar</button>' +
               '<button onclick="entExcluirRegra(\'' + r.id + '\')" ' +
               'style="background:color-mix(in srgb, var(--danger) 10%, transparent);border:1px solid color-mix(in srgb, var(--danger) 25%, transparent);color:var(--danger);' +
               'border-radius:7px;padding:4px 9px;cursor:pointer;font-size:11px;"><svg class="ic"><use href="#i-trash"/></svg></button>' +
               '</div>' +
               '</div>';
    }).join('');
}


// Remove uma regra fixa e todos os lançamentos gerados por ela
function entExcluirRegra(regraId) {
    salvarSnapshotUndo('excluir regra de entrada');
    if (!confirm('Excluir esta regra e remover todos os lançamentos gerados por ela?')) return;
    db.regras_fixas = db.regras_fixas.filter(function(r) { return r.id !== regraId; });
    db.transacoes   = db.transacoes.filter(function(t) { return t.origem_regra !== regraId; });
    sincronizar();
    entRenderizarRegras();
}

// Modal de edição de uma regra recorrente com seletor de mês de início
function entAbrirEdicaoRegra(regraId) {
    const regra = db.regras_fixas.find(function(r) { return r.id === regraId; });
    if (!regra) return;

    const ant = document.getElementById('modal-editar-regra-ent');
    if (ant) ant.remove();

    // Monta os próximos 12 meses como opções
    const mesesNome = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const hoje = new Date();
    const mesOpcoes = [];
    for (let i = 0; i < 13; i++) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
        const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
        const label = mesesNome[d.getMonth()] + ' ' + d.getFullYear();
        mesOpcoes.push({ key: key, label: label, atual: i === 0 });
    }

    const overlay = document.createElement('div');
    overlay.id = 'modal-editar-regra-ent';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface);border:1px solid var(--w-13);border-radius:18px;width:92%;max-width:420px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,0.9);display:flex;flex-direction:column;gap:14px;';

    box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<h3 style="color:var(--primary);margin:0;font-size:16px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar Regra Recorrente</h3>' +
        '<button id="eer-fechar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:20px;line-height:1;"><svg class="ic"><use href="#i-x"/></svg></button></div>' +

        '<div style="font-size:11px;color:var(--text-muted);padding:8px 12px;background:color-mix(in srgb, var(--accent) 8%, transparent);border-radius:8px;border:1px solid color-mix(in srgb, var(--accent) 20%, transparent);">' +
        'A alteração valerá a partir do mês que você selecionar. Os valores já lançados nos meses anteriores <strong style="color:var(--text-main);">não serão alterados</strong>.</div>' +

        '<div><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:5px;">DESCRIÇÃO</label>' +
        '<input id="eer-desc" type="text" class="form-control" value="' + regra.desc + '"></div>' +

        '<div style="display:flex;gap:10px;">' +
        '<div style="flex:2;"><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:5px;">VALOR R$</label>' +
        '<input id="eer-valor" type="number" step="0.01" class="form-control" value="' + regra.valor.toFixed(2) + '"></div>' +
        '<div style="flex:1;"><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:5px;">DIA</label>' +
        '<input id="eer-dia" type="number" class="form-control" min="1" max="31" value="' + regra.dia + '"></div>' +
        '</div>' +

        '<div><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.5px;display:block;margin-bottom:8px;">VIGENTE A PARTIR DE</label>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
        mesOpcoes.map(function(m) {
            return '<button class="eer-mes-btn" data-mes="' + m.key + '" ' +
                   'style="padding:6px 10px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;transition:all 0.15s;' +
                   'background:' + (m.atual ? 'var(--accent)' : 'var(--w-06)') + ';' +
                   'border:1px solid ' + (m.atual ? 'var(--accent)' : 'var(--w-12)') + ';' +
                   'color:' + (m.atual ? 'var(--on-accent)' : 'var(--text-muted)') + ';">' +
                   m.label + '</button>';
        }).join('') +
        '</div></div>' +

        '<div style="display:flex;gap:10px;">' +
        '<button id="eer-cancelar" style="flex:1;background:var(--w-06);border:1px solid var(--w-12);color:var(--text-muted);border-radius:10px;padding:12px;cursor:pointer;font-weight:600;">Cancelar</button>' +
        '<button id="eer-salvar" style="flex:2;background:var(--accent);color:var(--on-accent);border:none;border-radius:10px;padding:12px;cursor:pointer;font-weight:700;font-size:14px;">Salvar</button>' +
        '</div>' +
        '<button id="eer-excluir" style="width:100%;background:color-mix(in srgb, var(--danger) 10%, transparent);border:1px solid color-mix(in srgb, var(--danger) 25%, transparent);color:var(--danger);border-radius:10px;padding:11px;cursor:pointer;font-weight:600;font-size:13px;"><svg class="ic ic-t"><use href="#i-trash"/></svg>Excluir esta regra de todos os meses</button>';

    // Seleção de mês
    let mesSelecionado = mesOpcoes[0].key;
    box.querySelectorAll('.eer-mes-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            box.querySelectorAll('.eer-mes-btn').forEach(function(b) {
                b.style.background = 'var(--w-06)';
                b.style.borderColor = 'var(--w-12)';
                b.style.color = 'var(--text-muted)';
            });
            this.style.background = 'var(--accent)';
            this.style.borderColor = 'var(--accent)';
            this.style.color = 'var(--on-accent)';
            mesSelecionado = this.dataset.mes;
        });
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#eer-fechar').addEventListener('click', function() { overlay.remove(); });
    box.querySelector('#eer-cancelar').addEventListener('click', function() { overlay.remove(); });
    box.querySelector('#eer-excluir').addEventListener('click', function() { overlay.remove(); entExcluirRegra(regraId); });
    box.querySelector('#eer-salvar').addEventListener('click', function() {
        const novaDesc  = document.getElementById('eer-desc').value.trim();
        const novoValor = parseFloat(document.getElementById('eer-valor').value);
        const novoDia   = document.getElementById('eer-dia').value || regra.dia;
        if (!novaDesc || isNaN(novoValor)) return alert('Preencha todos os campos!');

        // Atualiza a regra com os novos valores e nova data de início
        regra.desc  = novaDesc;
        regra.valor = novoValor;
        regra.dia   = novoDia;
        regra.inicio = mesSelecionado;

        // Atualiza transações já geradas a partir do mês selecionado
        // (apenas as que não foram editadas manualmente, origem_regra === regra.id)
        db.transacoes.forEach(function(t) {
            if (t.origem_regra === regra.id && t.data >= mesSelecionado) {
                t.desc  = novaDesc;
                t.valor = novoValor;
                // Ajusta o dia da data mantendo o mês/ano
                const partes = t.data.split('-');
                t.data = partes[0] + '-' + partes[1] + '-' + String(novoDia).padStart(2,'0');
            }
        });

        overlay.remove();
        sincronizar();
        entRenderizarRegras();
    });
}

// ==== LÓGICA DE ENTRADAS (REGRAS E AVULSAS) ====
function salvarEntrada() {
    const tipo = document.getElementById('tipo-entrada').value;
    const desc = document.getElementById('ent-desc').value;
    const valor = parseFloat(document.getElementById('ent-valor').value);
    const dia = document.getElementById('ent-dia').value || "01";
    if (!desc || isNaN(valor)) return alert("Preencha descrição e valor!");
    if (tipo === 'fixa') {
        const mesCriacao = `${dataAtual.getFullYear()}-${String(dataAtual.getMonth() + 1).padStart(2, '0')}`;
        db.regras_fixas.push({ id: 'regra_' + Date.now(), desc, valor, dia, inicio: mesCriacao });
    } else {
        const dataStr = `${dataAtual.getFullYear()}-${String(dataAtual.getMonth() + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
        db.transacoes.push({ id: 'avulsa_' + Date.now(), desc, valor, data: dataStr, origem_regra: null });
    }
    document.getElementById('ent-desc').value = '';
    document.getElementById('ent-valor').value = '';
    sincronizar();
}

function verificarEGerarFixas() {
    const mesAnoAtual = `${dataAtual.getFullYear()}-${String(dataAtual.getMonth() + 1).padStart(2, '0')}`;
    let mudou = false;
    db.regras_fixas.forEach(regra => {
        if (mesAnoAtual >= regra.inicio) {
            const jaExiste = db.transacoes.find(t => t.origem_regra === regra.id && t.data.startsWith(mesAnoAtual));
            if (!jaExiste) {
                db.transacoes.push({ id: 'trans_' + Date.now() + Math.random(), desc: regra.desc, valor: regra.valor, data: `${mesAnoAtual}-${String(regra.dia).padStart(2, '0')}`, origem_regra: regra.id });
                mudou = true;
            }
        }
    });
    if (mudou) sincronizar();
}

function deletarTransacao(id) {
    salvarSnapshotUndo('excluir entrada');
    const transacao = db.transacoes.find(t => t.id === id);
    if (!transacao) return;
    if (transacao.origem_regra !== null) return alert("Exclua a regra fixa em configurações.");
    if (confirm("Excluir ganho avulso?")) { db.transacoes = db.transacoes.filter(t => t.id !== id); sincronizar(); }
}
function editarValorTransacao(id, novoValor) {
    const idx = db.transacoes.findIndex(t => t.id === id);
    if (idx !== -1) { db.transacoes[idx].valor = parseFloat(novoValor); sincronizar(); }
}
function deletarRegra(id) {
    salvarSnapshotUndo('excluir regra');
    if (confirm("Deletar esta regra fixa?")) { db.regras_fixas = db.regras_fixas.filter(r => r.id !== id); sincronizar(); }
}


// ==== LÓGICA DA ABA GASTOS FIXOS ====

// Redistribui o valor padrão igualmente entre os donos no formulário da sidebar
function redistribuirIgualRGF() {
    const valor = parseFloat(document.getElementById('rgf-valor').value) || 0;
    const inputs = document.querySelectorAll('.input-valor-dono-rgf');
    if (inputs.length === 0) return;
    const porPessoa = valor / inputs.length;
    inputs.forEach(function(inp) {
        if (!inp.dataset.manual) inp.value = porPessoa.toFixed(2);
    });
}

// Preenche selects do formulário na sidebar (roda ao abrir a aba)
function preencherFormularioFixos() {
    const catSelect = document.getElementById('rgf-cat');
    if (!catSelect) return;
    catSelect.innerHTML = db_categorias.map(function(c) {
        return '<option value="' + c.id + '">' + c.nome + '</option>';
    }).join('');
    atualizarSubcategoriasRGF();
    // Garante pelo menos 1 pessoa (Principal) no formulário
    const container = document.getElementById('container-donos-rgf');
    if (container && container.children.length === 0) {
        const principal = db_pessoas.find(function(p) { return p.tipo === 'principal'; });
        adicionarDonoRGF(principal ? principal.id : '');
    }
}

// Abre o modal de edição de um gasto fixo específico no mês atual
// ID global do gasto fixo em edição — elimina passagem de argumento em onclick
let _mefId = null;

function mefFechar()  { const m = document.getElementById('modal-editar-fixo');   if (m) m.remove(); }
function mefFecharEx(){ const m = document.getElementById('modal-excluir-fixo');  if (m) m.remove(); }

function abrirEdicaoGastoFixo(gastoId) {
    _mefId = gastoId;
    const g = db_gastos_pontuais.find(function(x) { return x.id === gastoId; });
    if (!g) return;

    const regra   = db_regras_gastos_fixos.find(function(r) { return r.id === g.origem_regra; });
    const cat     = db_categorias.find(function(c) { return c.id === g.cat_id; });
    const meses   = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const nomeMes = meses[dataAtual.getMonth()];
    const valorPadrao = regra ? Number(regra.valor).toFixed(2) : g.valor.toFixed(2);

    mefFechar();

    const overlay = document.createElement('div');
    overlay.id = 'modal-editar-fixo';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.72);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) mefFechar(); });

    const box = document.createElement('div');
    box.style.cssText = 'background:rgba(15,20,42,0.97);border:1px solid var(--w-13);border-radius:18px;width:92%;max-width:420px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,0.85);display:flex;flex-direction:column;gap:14px;max-height:88vh;overflow-y:auto;';

    // Cabeçalho e campos estáticos via innerHTML
    box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<h3 style="color:var(--primary);margin:0;font-size:16px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>' + g.desc + '</h3>' +
            '<button id="mef-btn-fechar" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:20px;line-height:1;"><svg class="ic"><use href="#i-x"/></svg></button>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);padding:10px 12px;background:color-mix(in srgb, var(--warning) 7%, transparent);border-radius:8px;border:1px solid color-mix(in srgb, var(--warning) 20%, transparent);">' +
            'Editando somente <strong style="color:var(--warning);">' + nomeMes + '</strong>. ' +
            'Os outros meses continuam com o valor padrão' +
            (regra ? ' <strong style="color:var(--text-main);">(R$ ' + valorPadrao + ')</strong>.' : '.') +
        '</div>' +
        '<div><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;display:block;margin-bottom:6px;">DESCRIÇÃO NESTE MÊS</label>' +
            '<input id="mef-desc" type="text" class="form-control" value="' + g.desc + '"></div>' +
        '<div><label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;display:block;margin-bottom:6px;">CATEGORIA</label>' +
            '<div style="font-size:13px;color:var(--text-main);padding:10px 12px;background:var(--k-25);border-radius:8px;border:1px solid rgba(255,255,255,0.07);">' + (cat ? cat.nome : 'Sem categoria') + '</div></div>' +

        // Pessoas — cabeçalho + botão adicionar
        '<div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
                '<label style="font-size:10px;font-weight:700;color:var(--text-muted);letter-spacing:0.6px;">PESSOAS E VALORES</label>' +
                '<button id="mef-btn-add-pessoa" style="background:var(--accent);color:var(--on-accent);border:none;border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;cursor:pointer;">+ Pessoa</button>' +
            '</div>' +
            '<div id="mef-donos-container" style="display:flex;flex-direction:column;gap:6px;"></div>' +
        '</div>' +

        '<div style="padding:10px 12px;background:var(--k-25);border-radius:8px;text-align:center;">' +
            '<span style="font-size:11px;color:var(--text-muted);">TOTAL: </span>' +
            '<span id="mef-total" style="font-weight:800;color:var(--warning);font-size:18px;">' + formatarMoeda(g.valor) + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:10px;">' +
            '<button id="mef-btn-cancelar" style="flex:1;background:var(--w-06);border:1px solid var(--w-12);color:var(--text-muted);border-radius:10px;padding:12px;cursor:pointer;font-weight:600;">Cancelar</button>' +
            '<button id="mef-btn-salvar" style="flex:2;background:var(--accent);color:var(--on-accent);border:none;border-radius:10px;padding:12px;cursor:pointer;font-weight:700;font-size:14px;">Salvar para ' + nomeMes + '</button>' +
        '</div>' +
        '<button id="mef-btn-salvar-futuro" style="width:100%;background:color-mix(in srgb, var(--accent) 12%, transparent);border:1px solid color-mix(in srgb, var(--accent) 28%, transparent);color:var(--info);border-radius:10px;padding:11px;cursor:pointer;font-weight:600;font-size:12px;"><svg class="ic ic-t"><use href="#i-fixos"/></svg>Salvar e aplicar nos próximos meses</button>' +
        '<button id="mef-btn-excluir" style="width:100%;background:color-mix(in srgb, var(--danger) 10%, transparent);border:1px solid color-mix(in srgb, var(--danger) 25%, transparent);color:var(--danger);border-radius:10px;padding:11px;cursor:pointer;font-weight:600;font-size:13px;"><svg class="ic ic-t"><use href="#i-trash"/></svg>Excluir este gasto fixo</button>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Preencher linhas de pessoas existentes via DOM (sem HTML inline)
    g.divisao.forEach(function(d) { mefAdicionarPessoa(d.pessoa_id, d.valor); });

    // Eventos
    box.querySelector('#mef-btn-fechar').addEventListener('click',  mefFechar);
    box.querySelector('#mef-btn-cancelar').addEventListener('click', mefFechar);
    box.querySelector('#mef-btn-salvar').addEventListener('click',   mefSalvar);
    box.querySelector('#mef-btn-salvar-futuro').addEventListener('click', mefSalvarComFuturo);
    box.querySelector('#mef-btn-excluir').addEventListener('click',  mefExcluir);
    box.querySelector('#mef-btn-add-pessoa').addEventListener('click', function() { mefAdicionarPessoa(); setTimeout(mefRedistribuir, 50); });

    setTimeout(function() { const el = document.getElementById('mef-desc'); if (el) el.focus(); }, 60);
}

// Adiciona uma linha de pessoa no modal de edição de gasto fixo
function mefAdicionarPessoa(pessoaId, valor) {
    const container = document.getElementById('mef-donos-container');
    if (!container) return;
    const opts = db_pessoas.map(function(p) {
        return '<option value="' + p.id + '"' + (pessoaId === p.id ? ' selected' : '') + '>' + p.nome + '</option>';
    }).join('');
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const sel = document.createElement('select');
    sel.className = 'form-control mef-sel-pessoa'; sel.style.flex = '1';
    sel.innerHTML = opts;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.01';
    inp.className = 'input-quick mef-valor-pessoa'; inp.style.width = '100px';
    inp.value = valor !== undefined ? Number(valor).toFixed(2) : '';
    inp.placeholder = 'R$';
    inp.addEventListener('input', mefAtualizarTotal);
    const btn = document.createElement('button');
    btn.style.cssText = 'background:color-mix(in srgb, var(--danger) 15%, transparent);border:1px solid color-mix(in srgb, var(--danger) 30%, transparent);color:var(--danger);border-radius:7px;padding:0 10px;height:40px;cursor:pointer;font-size:14px;flex-shrink:0;';
    btn.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    btn.addEventListener('click', function() { row.remove(); mefAtualizarTotal(); });
    row.appendChild(sel); row.appendChild(inp); row.appendChild(btn);
    container.appendChild(row);
    mefAtualizarTotal();
}

function mefSalvarComFuturo() {
    // Salva este mês (igual ao mefSalvar)
    mefSalvar();
    // E também atualiza a regra original para os próximos meses
    const g = db_gastos_pontuais.find(function(x) { return x.id === _mefId; });
    if (!g || !g.origem_regra) return;
    const regra = db_regras_gastos_fixos.find(function(r) { return r.id === g.origem_regra; });
    if (!regra) return;

    const sels = document.querySelectorAll('.mef-sel-pessoa');
    const inps = document.querySelectorAll('.mef-valor-pessoa');
    if (sels.length === 0) return;

    // Atualiza divisão da regra
    const novaDivisao = [];
    let novoTotal = 0;
    sels.forEach(function(sel, i) {
        const v = parseFloat(inps[i] ? inps[i].value : 0) || 0;
        novaDivisao.push({ pessoa_id: sel.value, valor: v });
        novoTotal += v;
    });
    regra.divisao = novaDivisao;
    regra.valor   = novoTotal;

    // Atualiza também todos os lançamentos futuros desta regra
    const mesAtual = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    db_gastos_pontuais.forEach(function(gasto) {
        if (gasto.origem_regra === regra.id && gasto.mes_ref > mesAtual) {
            gasto.divisao = novaDivisao.map(function(d) { return { pessoa_id: d.pessoa_id, valor: d.valor }; });
            gasto.valor   = novoTotal;
        }
    });

    sincronizarRegrasGastosFixos();
    sincronizarGastosPontuais();
}

function mefAtualizarTotal() {
    let total = 0;
    document.querySelectorAll('.mef-valor-pessoa').forEach(function(inp) { total += parseFloat(inp.value) || 0; });
    const el = document.getElementById('mef-total');
    if (el) el.textContent = formatarMoeda(total);
}

// Redistribui igualmente entre todas as pessoas ao adicionar/remover
function mefRedistribuir() {
    const inps  = document.querySelectorAll('.mef-valor-pessoa');
    const total = parseFloat((document.getElementById('mef-total') || {textContent:'0'}).textContent.replace('R$','').replace(',','.').trim()) || 0;
    if (inps.length === 0 || total === 0) return;
    const por = (total / inps.length).toFixed(2);
    inps.forEach(function(inp, i) {
        inp.value = i === inps.length - 1
            ? (total - por * (inps.length - 1)).toFixed(2)
            : por;
    });
    mefAtualizarTotal();
}

function mefSalvar() {
    const g = db_gastos_pontuais.find(function(x) { return x.id === _mefId; });
    if (!g) return;
    const novaDesc = document.getElementById('mef-desc').value.trim();
    if (novaDesc) g.desc = novaDesc;

    // Reconstruir divisão com as pessoas e valores atuais do modal
    const sels = document.querySelectorAll('.mef-sel-pessoa');
    const inps = document.querySelectorAll('.mef-valor-pessoa');
    if (sels.length > 0) {
        const novaDivisao = [];
        let novoTotal = 0;
        sels.forEach(function(sel, i) {
            const v = parseFloat(inps[i] ? inps[i].value : 0) || 0;
            novaDivisao.push({ pessoa_id: sel.value, valor: v });
            novoTotal += v;
        });
        g.divisao = novaDivisao;
        g.valor   = novoTotal;
    } else {
        // fallback: só atualiza valores
        let novoTotal = 0;
        inps.forEach(function(inp) {
            const div = g.divisao.find(function(d) { return d.pessoa_id === inp.dataset.pessoa; });
            const v = parseFloat(inp.value) || 0;
            if (div) div.valor = v;
            novoTotal += v;
        });
        g.valor = novoTotal;
    }

    g.valor_editado = true;
    mefFechar();
    sincronizarGastosPontuais();
}

function mefExcluir() {
    salvarSnapshotUndo('excluir gasto fixo');
    const g = db_gastos_pontuais.find(function(x) { return x.id === _mefId; });
    if (!g) return;
    const regra  = db_regras_gastos_fixos.find(function(r) { return r.id === g.origem_regra; });
    const meses  = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const nomeMes = meses[dataAtual.getMonth()];
    mefFechar();

    const overlay = document.createElement('div');
    overlay.id = 'modal-excluir-fixo';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) mefFecharEx(); });

    const box = document.createElement('div');
    box.style.cssText = 'background:rgba(15,20,42,0.97);border:1px solid var(--w-13);border-radius:18px;width:92%;max-width:380px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,0.85);display:flex;flex-direction:column;gap:14px;';
    box.innerHTML =
        '<h3 style="color:var(--danger);margin:0;font-size:16px;"><svg class="ic ic-t"><use href="#i-trash"/></svg>Excluir Gasto Fixo</h3>' +
        '<p style="font-size:13px;color:var(--text-muted);margin:0;"><strong style="color:var(--text-main);">' + g.desc + '</strong><br>Escolha como deseja excluir:</p>' +
        '<button id="mef-ex-mes" style="background:color-mix(in srgb, var(--warning) 10%, transparent);border:1px solid color-mix(in srgb, var(--warning) 25%, transparent);color:var(--warning);border-radius:10px;padding:14px;cursor:pointer;font-weight:700;text-align:left;">' +
            '<svg class="ic ic-t"><use href="#i-calendar"/></svg>Só ' + nomeMes + '<br><span style="font-size:11px;font-weight:400;color:var(--text-muted);">Remove apenas este mês. Nos outros meses continua aparecendo.</span></button>' +
        (regra ? '<button id="mef-ex-regra" style="background:color-mix(in srgb, var(--danger) 10%, transparent);border:1px solid color-mix(in srgb, var(--danger) 25%, transparent);color:var(--danger);border-radius:10px;padding:14px;cursor:pointer;font-weight:700;text-align:left;">' +
            '<svg class="ic ic-t"><use href="#i-trash"/></svg>Excluir regra permanentemente<br><span style="font-size:11px;font-weight:400;color:var(--text-muted);">Remove a regra e todos os lançamentos futuros.</span></button>' : '') +
        '<button id="mef-ex-cancelar" style="background:var(--w-05);border:1px solid rgba(255,255,255,0.10);color:var(--text-muted);border-radius:10px;padding:11px;cursor:pointer;font-weight:600;">Cancelar</button>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    box.querySelector('#mef-ex-mes').addEventListener('click', mefExcluirMes);
    box.querySelector('#mef-ex-cancelar').addEventListener('click', mefFecharEx);
    if (regra) box.querySelector('#mef-ex-regra').addEventListener('click', function() { mefExcluirRegra(regra.id); });
}

function mefExcluirMes() {
    salvarSnapshotUndo('excluir gasto do mês');
    const g = db_gastos_pontuais.find(function(x) { return x.id === _mefId; });
    // Anota na regra que este mês foi excluído; senão o sistema recriaria o gasto ao reabrir o mês
    const regra = g && g.origem_regra ? db_regras_gastos_fixos.find(function(r) { return r.id === g.origem_regra; }) : null;
    if (regra) {
        regra.meses_pulados = regra.meses_pulados || [];
        if (regra.meses_pulados.indexOf(g.mes_ref) === -1) regra.meses_pulados.push(g.mes_ref);
    }
    db_gastos_pontuais = db_gastos_pontuais.filter(function(x) { return x.id !== _mefId; });
    mefFecharEx();
    if (regra) sincronizarRegrasGastosFixos();
    sincronizarGastosPontuais();
}

function mefExcluirRegra(regraId) {
    salvarSnapshotUndo('excluir regra de gasto fixo');
    const mesAtual = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    db_regras_gastos_fixos = db_regras_gastos_fixos.filter(function(r) { return r.id !== regraId; });
    db_gastos_pontuais = db_gastos_pontuais.filter(function(g) {
        return !(g.origem_regra === regraId && g.mes_ref >= mesAtual);
    });
    mefFecharEx();
    sincronizarRegrasGastosFixos();
    sincronizarGastosPontuais();
}

// salvarEdicaoGastoFixo removida — lógica agora inline no modal

// Renderiza a lista de gastos fixos no corpo da página (somente p_principal)
function renderizarAreaFixos(mesAnoAtual, meses) {
    const area = document.getElementById('area-exibicao-fixos');
    if (!area) return;

    // Apenas os gerados por regra fixa E onde p_principal aparece na divisão
    const principal = db_pessoas.find(function(p) { return p.tipo === 'principal'; });
    const idPrincipal = principal ? principal.id : 'p_principal';

    const fixosMes = db_gastos_pontuais.filter(function(g) {
        if (!g.origem_regra || g.mes_ref !== mesAnoAtual) return false;
        return g.divisao.some(function(d) { return d.pessoa_id === idPrincipal; });
    });

    const totalMeusMes = fixosMes.reduce(function(acc, g) {
        const minhaParte = g.divisao.find(function(d) { return d.pessoa_id === idPrincipal; });
        return acc + (minhaParte ? minhaParte.valor : 0);
    }, 0);

    // Dívidas fixas pagas pelo cartão: aparecem aqui, mas JÁ estão somadas nas faturas (não entram de novo nos totais do mês)
    const fixosCartao = db_faturas.filter(function(f) {
        return f.fixo && f.mes_fatura === mesAnoAtual && f.divisao.some(function(d) { return d.pessoa_id === idPrincipal; });
    }).sort(function(a, b) { return (a.data_compra || '').localeCompare(b.data_compra || ''); });
    const totalMeusCartao = fixosCartao.reduce(function(acc, f) {
        const m = f.divisao.find(function(d) { return d.pessoa_id === idPrincipal; });
        return acc + (m ? m.valor : 0);
    }, 0);

    const totalGeral = fixosMes.reduce(function(acc, g) { return acc + g.valor; }, 0);

    const listaHtml = fixosMes.map(function(g) {
        const cat = db_categorias.find(function(c) { return c.id === g.cat_id; });
        const minhaParte = g.divisao.find(function(d) { return d.pessoa_id === idPrincipal; });
        const meuValor = minhaParte ? minhaParte.valor : 0;

        // Outras pessoas na divisão
        const outros = g.divisao.filter(function(d) { return d.pessoa_id !== idPrincipal; });
        const outrosHtml = outros.map(function(d) {
            const p = db_pessoas.find(function(x) { return x.id === d.pessoa_id; });
            return `<span style="background:var(--surface-2);padding:2px 8px;border-radius:4px;font-size:10px;color:var(--text-muted);">
                ${p ? p.nome : '?'}: R$ ${d.valor.toFixed(2)}
            </span>`;
        }).join('');

        const tagEditado = g.valor_editado
            ? '<span style="font-size:9px;color:var(--warning);background:color-mix(in srgb, var(--warning) 14%, transparent);padding:2px 6px;border-radius:4px;margin-left:6px;">editado</span>'
            : '';

        return `<div style="background:var(--card-bg);padding:16px;border-radius:12px;border:1px solid var(--border);margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
                <div style="flex:1;min-width:0;">
                    <div style="font-size:14px;font-weight:600;color:var(--text-main);margin-bottom:4px;">
                        <svg class="ic ic-t"><use href="#i-fixos"/></svg>${g.desc}${tagEditado}
                    </div>
                    <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">
                        ${cat ? cat.nome : 'Sem categoria'} &bull; Dia ${g.data.split('-')[2]}
                    </div>
                    ${outros.length > 0 ? '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + outrosHtml + '</div>' : ''}
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
                    <span style="font-size:18px;font-weight:bold;color:var(--danger);">
                        ${formatarMoeda(meuValor)}
                    </span>
                    ${outros.length > 0 ? '<span style="font-size:10px;color:var(--text-muted);">Total: ' + formatarMoeda(g.valor) + '</span>' : ''}
                    <button onclick="abrirEdicaoGastoFixo('${g.id}')"
                        style="background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:8px;padding:4px 10px;cursor:pointer;font-size:11px;display:flex;align-items:center;gap:4px;">
                        <svg class="ic ic-t"><use href="#i-edit"/></svg>Editar
                    </button>
                </div>
            </div>
        </div>`;
    }).join('');

    const listaCartaoHtml = fixosCartao.map(function(f) {
        const cat = db_categorias.find(function(c) { return c.id === f.cat_id; });
        const cartao = db_cartoes.find(function(c) { return c.id === f.cartao_id; });
        const m = f.divisao.find(function(d) { return d.pessoa_id === idPrincipal; });
        const outros = f.divisao.filter(function(d) { return d.pessoa_id !== idPrincipal; });
        const outrosHtml = outros.map(function(d) {
            const p = db_pessoas.find(function(x) { return x.id === d.pessoa_id; });
            return '<span style="background:var(--surface-2);padding:2px 8px;border-radius:4px;font-size:10px;color:var(--text-muted);">' + (p ? p.nome : '?') + ': R$ ' + d.valor.toFixed(2) + '</span>';
        }).join('');
        const parc = f.total_parcelas > 1 ? ' &bull; parcela ' + f.parcela_atual + '/' + f.total_parcelas : '';
        return '<div style="background:var(--card-bg);padding:16px;border-radius:12px;border:1px solid var(--border);margin-bottom:10px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;"><div style="flex:1;min-width:0;">' +
            '<div style="font-size:14px;font-weight:600;color:var(--text-main);margin-bottom:4px;"><svg class="ic ic-t"><use href="#i-cartao"/></svg>' + f.desc + '</div>' +
            '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">' + (cat ? cat.nome : 'Sem categoria') + ' &bull; ' + (cartao ? cartao.nome : 'Cartão') + parc + '</div>' +
            (outros.length > 0 ? '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + outrosHtml + '</div>' : '') + '</div>' +
            '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">' +
            '<span style="font-size:18px;font-weight:bold;color:var(--danger);">' + formatarMoeda(m ? m.valor : 0) + '</span>' +
            (outros.length > 0 ? '<span style="font-size:10px;color:var(--text-muted);">Total: ' + formatarMoeda(f.valor_parcela) + '</span>' : '') +
            '<div style="display:flex;gap:6px;"><button onclick="abrirEdicaoFatura(\'' + f.id + '\')" style="background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:8px;padding:4px 10px;cursor:pointer;font-size:11px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar</button>' +
            '<button onclick="alternarFixoFatura(\'' + f.id + '\')" style="background:none;border:1px solid var(--border);color:var(--text-muted);border-radius:8px;padding:4px 10px;cursor:pointer;font-size:11px;">Tirar de fixos</button></div>' +
            '</div></div></div>';
    }).join('');

    const semFixosHtml = `<div style="text-align:center;padding:60px 20px;color:var(--text-muted);">
        <div style="font-size:40px;margin-bottom:16px;"><svg class="ic"><use href="#i-orc"/></svg></div>
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;">Nenhum gasto fixo neste mês</div>
        <div style="font-size:12px;">Use o formulário ao lado para cadastrar gastos recorrentes.</div>
    </div>`;

    area.innerHTML = `
        <div style="margin-bottom:25px;border-bottom:1px solid var(--border);padding-bottom:15px;">
            <h3 style="color:var(--primary);font-size:18px;margin:0;"><svg class="ic ic-t"><use href="#i-fixos"/></svg>Gastos Fixos — ${meses[dataAtual.getMonth()]}</h3>
        </div>

        <div style="background:var(--card-bg);border-radius:12px;border:1px solid var(--border);
                    overflow:hidden;max-width:700px;margin-bottom:25px;">
            <div style="background:var(--surface-2);padding:20px;border-bottom:1px solid var(--border);">
                <div style="display:flex;gap:30px;flex-wrap:wrap;">
                    <div>
                        <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">${fixosCartao.length > 0 ? 'FIXOS FORA DO CARTÃO — MINHA PARTE' : 'MINHA PARTE'}</div>
                        <div style="font-size:26px;font-weight:bold;color:var(--danger);">${formatarMoeda(totalMeusMes)}</div>
                    </div>
                    ${fixosCartao.length > 0 ? `<div>
                        <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">FIXOS NO CARTÃO (JÁ NA FATURA)</div>
                        <div style="font-size:26px;font-weight:bold;color:var(--info);">${formatarMoeda(totalMeusCartao)}</div>
                    </div>
                    <div>
                        <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">TOTAL DE FIXOS (VISÃO)</div>
                        <div style="font-size:26px;font-weight:bold;color:var(--text-main);">${formatarMoeda(totalMeusMes + totalMeusCartao)}</div>
                    </div>` : ''}
                    ${totalGeral !== totalMeusMes ? `<div>
                        <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">TOTAL GERAL</div>
                        <div style="font-size:26px;font-weight:bold;color:var(--warning);">${formatarMoeda(totalGeral)}</div>
                    </div>` : ''}
                </div>
            </div>
            <div style="padding:20px;">
                ${(fixosMes.length + fixosCartao.length) > 0 ? '' : semFixosHtml}
                ${fixosMes.length > 0 ? listaHtml : ''}
                ${fixosCartao.length > 0 ? `<div style="margin:18px 0 10px;padding-top:12px;border-top:1px dashed var(--border);">
                    <div style="font-size:12px;font-weight:700;color:var(--warning);"><svg class="ic ic-t"><use href="#i-cartao"/></svg>Fixos pagos no cartão</div>
                    <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Estes valores <strong>já estão somados na fatura do cartão</strong>, por isso não entram de novo no total do mês. Estão aqui só para você enxergar seus gastos fixos completos.</div>
                </div>` + listaCartaoHtml : ''}
            </div>
        </div>`;

    // Preenche o formulário da sidebar ao renderizar
    preencherFormularioFixos();
}

// ==========================================
// RENDERIZAÇÃO GERAL
// ==========================================
function renderizarApp() {
    verificarEGerarFixas();
    verificarEGerarGastosFixos();
    
    const meses = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
    const mesAnoAtual = `${dataAtual.getFullYear()}-${String(dataAtual.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('current-month-display').innerText = `${meses[dataAtual.getMonth()]} ${dataAtual.getFullYear()}`;

    // Atualiza Configuração de Regras Fixas
    const listaRegras = document.getElementById('lista-regras-fixas');
    if (listaRegras) {
        listaRegras.innerHTML = db.regras_fixas.map(r => `
            <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:8px; background:var(--surface-2); padding:10px; border-radius:8px; border:1px solid var(--border);">
                <span>${r.desc} (Dia ${r.dia})</span>
                <button onclick="deletarRegra('${r.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer;"><svg class="ic"><use href="#i-x"/></svg></button>
            </div>
        `).join('') || '';
    }

    // --- ABA DE ENTRADAS ---
    const transacoesMes = db.transacoes.filter(t => t.data.startsWith(mesAnoAtual));
    let totalEntradas = 0;
    const listaHtml = transacoesMes.map(t => {
        totalEntradas += t.valor;
        let btnDeletar = `<button onclick="deletarTransacao('${t.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer; margin-left:10px; font-weight:bold; font-size:14px;" title="${t.origem_regra ? 'Remover só este mês' : 'Excluir'}"><svg class="ic"><use href="#i-x"/></svg></button>`;
        return `
            <div class="item" style="max-width: 400px; margin-top: 10px;">
                <div class="item-info">
                    <h4 style="color:var(--success)">${t.desc}</h4>
                    <span style="font-size:10px; color:var(--text-muted)">Dia ${t.data.split('-')[2]}</span>
                </div>
                <div style="display:flex; align-items:center; gap:5px;">
                    <span style="font-size:11px; color:var(--text-muted)">R$</span>
                    <input type="number" step="0.01" class="input-quick" value="${t.valor}" onchange="editarValorTransacao('${t.id}', this.value)">
                    ${btnDeletar}
                </div>
            </div>
        `;
    }).join('');
    
    const areaEntradas = document.getElementById('area-exibicao-entradas');
    if (areaEntradas) areaEntradas.innerHTML = `
        <div style="border-bottom: 1px solid var(--border); padding-bottom: 15px; margin-bottom: 15px; max-width: 400px;">
            <h4 style="color:var(--success); font-size: 13px; font-weight:700;"><svg class="ic ic-t"><use href="#i-entrada"/></svg>Recebimentos do Mês</h4>
            <div style="font-size: 28px; font-weight: bold; margin-top: 5px;">${formatarMoeda(totalEntradas)}</div>
        </div>
        ${transacoesMes.length > 0 ? listaHtml : '<p style="color:grey; font-size:12px;">Nenhuma entrada.</p>'}
    `;

    // --- ABA DE FATURAS ---
    const areaFaturas = document.getElementById('area-exibicao-faturas');
    if (areaFaturas) {
        // mes_fatura é o mês de PAGAMENTO — o mês que GEROU os gastos é o anterior
        const mesGeradorIdx = dataAtual.getMonth() === 0 ? 11 : dataAtual.getMonth() - 1;
        const mesGeradorNome = meses[mesGeradorIdx];
        let faturasHtml = `<div style="margin-bottom: 25px; border-bottom: 1px solid var(--border); padding-bottom: 15px; width: 100%; display:flex; justify-content:space-between; align-items:flex-end; gap:14px; flex-wrap:wrap;">
            <div>
            <h3 style="color: var(--primary); font-size: 18px; margin: 0;"><svg class="ic ic-t"><use href="#i-receipt"/></svg>Faturas de ${meses[dataAtual.getMonth()]}</h3>
            <p style="color: var(--text-muted); font-size: 12px; margin: 4px 0 0 0;">Gastos gerados em ${mesGeradorNome} • Pagamento em ${meses[dataAtual.getMonth()]}</p>
            </div>
            <button type="button" id="btnImportarFatura" class="btn-importar-fatura" onclick="abrirImportacao()"><svg class="ic ic-t" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"/><path d="M14 3v5h5"/><path d="M12 17v-5"/><path d="M9.5 14.5L12 12l2.5 2.5"/></svg> Importar fatura</button>
        </div>`;
        faturasHtml += db_cartoes.map(c => {
            // Busca todas as faturas deste cartão no mês
            const todasDoMes = db_faturas.filter(f => f.cartao_id === c.id && f.mes_fatura === mesAnoAtual);

            // Busca a janela configurada (data_inicio e fechamento_dia) de qualquer fatura deste cartão/mês
            const fatRef = todasDoMes.find(function(f) { return f.data_inicio || f.fechamento_dia; });
            const dataInicio     = fatRef && fatRef.data_inicio    ? fatRef.data_inicio    : null;
            const dataFechamento = fatRef && fatRef.fechamento_dia ? fatRef.fechamento_dia : null;

            // Filtra por janela: se janela configurada, exibe só gastos dentro dela.
            // EXCEÇÃO: parcelados (total_parcelas > 1) sempre aparecem, independente da data —
            // pois representam compromissos já assumidos em meses anteriores.
            // Gastos sem data_compra também sempre aparecem (compatibilidade).
            const transacoesCartao = todasDoMes.filter(function(f) {
                if (!f.data_compra)        return true; // sem data: sempre exibe
                if (f.total_parcelas > 1)  return true; // parcelado: sempre exibe
                if (dataInicio     && f.data_compra < dataInicio)     return false;
                if (dataFechamento && f.data_compra > dataFechamento) return false;
                return true;
            });

            // Gastos fora da janela — apenas à vista, para avisar no cabeçalho
            const foraJanela = dataInicio || dataFechamento
                ? todasDoMes.filter(function(f) {
                    if (!f.data_compra)       return false;
                    if (f.total_parcelas > 1) return false; // parcelados não contam como "fora"
                    if (dataInicio     && f.data_compra < dataInicio)     return true;
                    if (dataFechamento && f.data_compra > dataFechamento) return true;
                    return false;
                })
                : [];

            let totalFatura = transacoesCartao.reduce((acc, t) => acc + t.valor_parcela, 0);

            let totalPorPessoa = {};
            transacoesCartao.forEach(t => t.divisao.forEach(d => totalPorPessoa[d.pessoa_id] = (totalPorPessoa[d.pessoa_id] || 0) + d.valor));

            const filtroAtivo = filtroFaturaPessoa[c.id] || null;
            let divisoesPessoasHtml = Object.keys(totalPorPessoa).map(pId => {
                let p = db_pessoas.find(p => p.id === pId);
                const ativo = filtroAtivo === pId;
                return `<div onclick="toggleFiltroPessoa('${c.id}', '${pId}')" style="background:${ativo ? 'var(--accent)' : 'var(--surface-2)'};padding:6px 12px;border-radius:8px;border:1px solid ${ativo ? 'var(--info)' : 'var(--border)'};font-size:11px;cursor:pointer;transition:0.15s;">
                    <span style="color:${ativo ? 'var(--on-accent)' : 'var(--text-muted)'};">${p ? p.nome : "..."}:</span>
                    <strong style="color:${ativo ? 'var(--on-accent)' : 'var(--info)'};font-size:12px;"> R$ ${totalPorPessoa[pId].toFixed(2)}</strong>
                </div>`;
            }).join('') || '<span style="color:grey; font-size:11px;">Sem gastos.</span>';

            // Aplica filtro por pessoa se houver
            // Aplica filtro por pessoa se houver
            const transacoesExibir = filtroAtivo
                ? transacoesCartao.filter(function(t) {
                    return t.divisao.some(function(d) { return d.pessoa_id === filtroAtivo; });
                  })
                : transacoesCartao;
            // Separa, e dentro de cada grupo ordena cronologicamente por data_compra
            const sortData = (a, b) => (a.data_compra || '').localeCompare(b.data_compra || '');
            const parceladas = transacoesExibir.filter(t => t.total_parcelas > 1).sort(sortData);
            const aVista    = transacoesExibir.filter(t => t.total_parcelas === 1).sort(sortData);

            function renderItemFatura(t, isParcelada) {
                const cat    = db_categorias.find(cat => cat.id === t.cat_id);
                const subcat = cat ? cat.subcategorias.find(s => s.id === t.subcat_id) : null;
                const nomesDivisao = t.divisao.map(d => db_pessoas.find(x => x.id === d.pessoa_id)?.nome || "Pessoa").join(', ');

                // Data formatada: DD/MM/YYYY
                const partsData = t.data_compra ? t.data_compra.split('-') : [];
                const dataFormatada = partsData.length === 3 ? partsData[2] + '/' + partsData[1] + '/' + partsData[0] : '';

                // Linha de detalhes: categoria • subcategoria • data • pessoas
                const detalhes = [
                    cat ? cat.nome : 'Sem Cat',
                    subcat ? subcat.nome : null,
                    dataFormatada || null,
                    nomesDivisao
                ].filter(Boolean).join(' &bull; ');

                // Borda esquerda azul nas parceladas — sem ocupar espaço extra
                const isEstorno  = t.valor_parcela < 0;
                const borderStyle = isEstorno
                    ? 'border-left: 3px solid var(--success); padding-left: 9px; margin-left: -12px;'
                    : isParcelada
                    ? 'border-left: 3px solid var(--info); padding-left: 9px; margin-left: -12px;'
                    : '';

                // Parcela no início do nome: negrito, cor azul, bem visível
                const tagFixo = t.fixo ? '<strong style="font-size:10px;color:var(--warning);font-weight:800;margin-right:6px;background:color-mix(in srgb, var(--warning) 12%, transparent);padding:1px 6px;border-radius:4px;"><svg class="ic ic-t"><use href="#i-fixos"/></svg>FIXO</strong>' : '';
                const tagParcela = isEstorno
                    ? '<strong style="font-size:11px;color:var(--success);font-weight:800;margin-right:6px;background:color-mix(in srgb, var(--success) 12%, transparent);padding:1px 6px;border-radius:4px;"><svg class="ic ic-t"><use href="#i-undo"/></svg>ESTORNO</strong>'
                    : isParcelada
                    ? `<strong style="font-size:12px;color:var(--info);font-weight:800;margin-right:6px;">${t.parcela_atual}/${t.total_parcelas}</strong>`
                    : '';

                return `
                <div onclick="toggleAcoesItem(this)"
                     style="padding: 12px 0; border-bottom: 1px dashed var(--border); cursor:pointer;">
                    <div style="display:flex; justify-content:space-between; align-items:center; ${borderStyle}">
                        <div style="min-width:0; flex:1;">
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-main); margin-bottom: 3px;">
                                ${tagFixo}${tagParcela}${t.desc}
                            </div>
                            <div style="font-size: 11px; color: var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${detalhes}</div>
                        </div>
                        <div style="font-size:16px;font-weight:bold;color:var(--danger);flex-shrink:0;margin-left:12px;">${formatarMoeda(t.valor_parcela)}</div>
                    </div>
                    <div class="item-acoes" style="display:none; justify-content:flex-end; align-items:center; gap:10px; margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">
                        <input type="number" step="0.01" class="input-quick" value="${t.valor_parcela.toFixed(2)}" onchange="editarValorFatura('${t.id}', this.value)" onclick="event.stopPropagation()">
                        <button onclick="event.stopPropagation(); alternarFixoFatura('${t.id}')" title="Mostrar (ou tirar) esta dívida na aba Gastos Fixos, sem somar duas vezes" style="background:none; border:1px solid var(--border); color:var(--warning); cursor:pointer; font-size:12px; border-radius:6px; padding:4px 8px;">${t.fixo ? '<svg class="ic ic-t"><use href="#i-fixos"/></svg>Tirar de fixos' : '<svg class="ic ic-t"><use href="#i-fixos"/></svg>Marcar fixo'}</button>
                        <button onclick="event.stopPropagation(); abrirEdicaoFatura('${t.id}')" style="background:none; border:1px solid var(--border); color:var(--info); cursor:pointer; font-size:12px; border-radius:6px; padding:4px 8px;"><svg class="ic ic-t"><use href="#i-edit"/></svg>Editar</button>
                        <button onclick="event.stopPropagation(); deletarFatura('${t.id}')" style="background:none; border:1px solid var(--border); color:var(--danger); cursor:pointer; font-size:12px; border-radius:6px; padding:4px 8px;"><svg class="ic ic-t"><use href="#i-x"/></svg>Excluir</button>
                    </div>
                </div>`;
            }

            // Parceladas PRIMEIRO, depois separador fino, depois à vista
            let listaComprasHtml = '';
            if (parceladas.length > 0) listaComprasHtml += parceladas.map(t => renderItemFatura(t, true)).join('');
            if (parceladas.length > 0 && aVista.length > 0) {
                listaComprasHtml += `<div style="display:flex;align-items:center;gap:10px;margin:8px 0;">
                    <div style="flex:1;height:1px;background:linear-gradient(to right, var(--info), transparent);opacity:0.4;"></div>
                    <span style="font-size:9px;color:var(--text-muted);letter-spacing:1px;flex-shrink:0;">À Vista</span>
                    <div style="flex:1;height:1px;background:linear-gradient(to left, var(--info), transparent);opacity:0.4;"></div>
                </div>`;
            }
            if (aVista.length > 0) listaComprasHtml += aVista.map(t => renderItemFatura(t, false)).join('');

            // Busca datas de abrangência já salvas nas faturas deste cartão/mês
            const fatRefCard = db_faturas.find(function(f){ return f.cartao_id === c.id && f.mes_fatura === mesAnoAtual; });
            const dataInicioSalva   = fatRefCard ? (fatRefCard.data_inicio   || '') : '';
            const dataFechamentoSalva = fatRefCard ? (fatRefCard.fechamento_dia || '') : '';
            const isColapsada = faturaColapsada[c.id] || false;
            const chevron = isColapsada ? '<svg class="ic"><use href="#i-chevr"/></svg>' : '<svg class="ic"><use href="#i-chevu"/></svg>';

            return `
                <div style="background:var(--card-bg);border-radius:12px;border:1px solid var(--border);margin-bottom:25px;overflow:hidden;width:100%;">
                    <!-- CABEÇALHO CLICÁVEL -->
                    <div onclick="toggleColapsarFatura('${c.id}')"
                         style="background:var(--w-05);padding:18px 20px;border-left:5px solid ${c.cor};border-bottom:1px solid var(--border);cursor:pointer;user-select:none;transition:background 0.2s;">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
                            <div>
                                <div style="display:flex;align-items:center;gap:10px;">
                                    <h4 style="margin:0;color:white;font-size:17px;font-weight:700;">${c.nome}</h4>
                                    <span style="font-size:10px;background:color-mix(in srgb, var(--warning) 15%, transparent);color:var(--warning);padding:2px 8px;border-radius:4px;border:1px solid color-mix(in srgb, var(--warning) 25%, transparent);">Fatura de ${mesGeradorNome}</span>
                                </div>
                                <!-- Datas de abrangência: Início e Fechamento -->
                                <div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap;" onclick="event.stopPropagation()">
                                    <span style="font-size:11px;color:var(--text-muted);">Vence: Dia ${c.vencimento}</span>
                                    <span style="color:var(--text-muted);font-size:11px;">&bull;</span>
                                    <span style="font-size:11px;color:var(--text-muted);">Início:</span>
                                    <input type="date"
                                        value="${dataInicioSalva}"
                                        onchange="salvarAbrangenciaFatura('${c.id}', '${mesAnoAtual}', 'inicio', this.value)"
                                        style="background:var(--k-30);border:1px solid var(--w-12);border-radius:6px;color:var(--success);padding:3px 7px;font-size:11px;">
                                    <span style="font-size:11px;color:var(--text-muted);">Fecha:</span>
                                    <input type="date"
                                        value="${dataFechamentoSalva}"
                                        onchange="salvarAbrangenciaFatura('${c.id}', '${mesAnoAtual}', 'fechamento', this.value)"
                                        style="background:var(--k-30);border:1px solid var(--w-12);border-radius:6px;color:var(--warning);padding:3px 7px;font-size:11px;">
                                </div>
                            </div>
                            <div style="display:flex;align-items:center;gap:12px;">
                                <button onclick="event.stopPropagation();abrirEstorno('${c.id}','${mesAnoAtual}')"
                                    style="background:color-mix(in srgb, var(--success) 12%, transparent);border:1px solid color-mix(in srgb, var(--success) 30%, transparent);color:var(--success);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:11px;font-weight:700;white-space:nowrap;"><svg class="ic ic-t"><use href="#i-undo"/></svg>Estorno</button>
                                <div style="text-align:right;">
                                    <div style="font-size:10px;color:var(--text-muted);letter-spacing:0.5px;">Total</div>
                                    <div style="font-size:24px;font-weight:800;color:var(--danger);">${formatarMoeda(totalFatura)}</div>
                                </div>
                                <span id="icone-colapso-${c.id}"
                                    style="font-size:18px;color:var(--text-muted);transition:transform 0.25s ease;display:inline-block;transform:${isColapsada ? 'rotate(-90deg)' : 'rotate(0deg)'};">
                                    <svg class="ic"><use href="#i-chevu"/></svg>
                                </span>
                            </div>
                        </div>
                        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">${divisoesPessoasHtml}</div>
                    </div>
                    <!-- CORPO COLAPSÁVEL -->
                    <div id="corpo-fatura-${c.id}" style="padding:20px;display:${isColapsada ? 'none' : 'block'};">
                        ${foraJanela.length > 0 ? `
                        <div style="margin-bottom:14px;">
                            <!-- Cabeçalho do aviso — clicável -->
                            <div onclick="toggleForaJanela('${c.id}')"
                                 style="background:color-mix(in srgb, var(--warning) 7%, transparent);border:1px solid color-mix(in srgb, var(--warning) 20%, transparent);
                                        border-radius:10px;padding:10px 14px;font-size:11px;color:var(--warning);
                                        display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;">
                                <div style="display:flex;align-items:center;gap:8px;">
                                    <span style="font-size:14px;"><svg class="ic"><use href="#i-alert"/></svg></span>
                                    <span>
                                        <strong>${foraJanela.length} gasto${foraJanela.length > 1 ? 's' : ''}</strong>
                                        fora da janela
                                        ${dataInicio ? dataInicio.split('-').reverse().join('/') : ''}${dataInicio && dataFechamento ? ' → ' : ''}${dataFechamento ? dataFechamento.split('-').reverse().join('/') : ''}
                                        — clique para ver
                                    </span>
                                </div>
                                <span id="chevron-fora-${c.id}" style="font-size:12px;transition:transform 0.2s;"><svg class="ic"><use href="#i-chevd"/></svg></span>
                            </div>
                            <!-- Lista expansível dos gastos ocultos -->
                            <div id="lista-fora-${c.id}" style="display:none;border:1px solid color-mix(in srgb, var(--warning) 15%, transparent);border-top:none;border-radius:0 0 10px 10px;overflow:hidden;">
                                ${foraJanela.map(function(t) {
                                    const cat = db_categorias.find(function(cat){ return cat.id === t.cat_id; });
                                    const partsD = t.data_compra ? t.data_compra.split('-') : [];
                                    const dataFmt = partsD.length === 3 ? partsD[2]+'/'+partsD[1]+'/'+partsD[0] : '—';
                                    return '<div style="display:flex;justify-content:space-between;align-items:center;' +
                                           'padding:10px 14px;border-bottom:1px solid var(--w-05);' +
                                           'background:color-mix(in srgb, var(--warning) 4%, transparent);">' +
                                           '<div>' +
                                           '<div style="font-size:12px;font-weight:600;color:var(--text-main);">' + t.desc + '</div>' +
                                           '<div style="font-size:10px;color:var(--text-muted);">' +
                                           (cat ? cat.nome : 'Sem cat') + ' • ' + dataFmt + ' • ' +
                                           'R$ ' + t.valor_parcela.toFixed(2) + '</div>' +
                                           '</div>' +
                                           '<div style="display:flex;gap:6px;">' +
                                           '<button onclick="abrirEdicaoFatura(\'' + t.id + '\')" ' +
                                           'style="background:color-mix(in srgb, var(--accent) 15%, transparent);border:1px solid color-mix(in srgb, var(--accent) 30%, transparent);' +
                                           'color:var(--info);border-radius:7px;padding:5px 10px;cursor:pointer;font-size:11px;font-weight:600;">' +
                                           '<svg class="ic ic-t"><use href="#i-edit"/></svg>Editar</button>' +
                                           '<button onclick="deletarFatura(\'' + t.id + '\')" ' +
                                           'style="background:color-mix(in srgb, var(--danger) 12%, transparent);border:1px solid color-mix(in srgb, var(--danger) 28%, transparent);' +
                                           'color:var(--danger);border-radius:7px;padding:5px 10px;cursor:pointer;font-size:11px;font-weight:600;">' +
                                           '<svg class="ic ic-t"><use href="#i-x"/></svg>Excluir</button>' +
                                           '</div>' +
                                           '</div>';
                                }).join('')}
                            </div>
                        </div>` : ''}
                        ${listaComprasHtml || '<p style="color:grey;font-size:12px;">Nenhum gasto registrado.</p>'}
                    </div>
                </div>`;
        }).join('');
        areaFaturas.innerHTML = faturasHtml;
        // Restaurar foco no campo de busca se estava ativo
    }

    // Renderiza aba de gastos pontuais
    renderizarAreaPontuais(mesAnoAtual, meses);

    // Renderiza aba de gastos fixos
    renderizarAreaFixos(mesAnoAtual, meses);

    if (painelAberto === 'dashboard') renderizarDashboard();
    if (painelAberto === 'orcamento') renderizarAreaOrcamento();
    if (painelAberto === 'relatorios' && window.Relatorios) Relatorios.renderizar();
}