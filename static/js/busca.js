/* Busca global: acha um lançamento em qualquer mês (cartão, gastos pontuais, fixos e entradas).
   Parte 1 (BuscaPura): contas puras, testadas sem navegador.  Parte 2: a barra no topo da tela. */
(function (global) {
    'use strict';

    const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const MESES_LONGOS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    const MAX_RESULTADOS = 60;

    function normalizar(t) {
        return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    }
    function rotuloMes(ym) {            // '2026-10' -> 'out/2026'
        if (!/^\d{4}-\d{2}$/.test(ym || '')) return '';
        return MESES[parseInt(ym.slice(5), 10) - 1] + '/' + ym.slice(0, 4);
    }
    function textoValor(v) {            // 129.9 -> '129.90 129,90'
        const n = Math.abs(Number(v) || 0).toFixed(2);
        return n + ' ' + n.replace('.', ',');
    }
    function nomePessoas(divisao, pessoas) {
        return (divisao || []).map(d => ((pessoas || []).find(p => p.id === d.pessoa_id) || {}).nome || '').filter(Boolean);
    }
    function nomeCategoria(cat_id, subcat_id, categorias) {
        const c = (categorias || []).find(x => x.id === cat_id);
        if (!c) return { cat: '', sub: '' };
        const s = (c.subcategorias || []).find(x => x.id === subcat_id);
        return { cat: c.nome || '', sub: s ? s.nome : '' };
    }

    // Todas as palavras digitadas precisam aparecer em algum lugar do lançamento (acento e maiúscula não importam).
    function casa(termos, palheiro) {
        return termos.every(t => palheiro.includes(t));
    }

    function montarItens(d) {
        const itens = [];
        (d.faturas || []).forEach(f => {
            const cartao = ((d.cartoes || []).find(c => c.id === f.cartao_id) || {}).nome || '';
            const cs = nomeCategoria(f.cat_id, f.subcat_id, d.categorias);
            const pessoas = nomePessoas(f.divisao, d.pessoas);
            const parcelado = (f.total_parcelas || 1) > 1;
            itens.push({
                tipo: f.fixo ? 'fixo_cartao' : 'fatura', id: f.id, grupo: f.id_compra_pai || f.id, parcela: f.parcela_atual || 1,
                total_parcelas: f.total_parcelas || 1, titulo: f.desc, valor: Number(f.valor_parcela) || 0, mes: f.mes_fatura,
                painel: 'faturas', quando: f.data_compra || '',
                sub: [cartao, cs.cat + (cs.sub ? ' › ' + cs.sub : ''), pessoas.join(', '), parcelado ? 'parcela ' + f.parcela_atual + '/' + f.total_parcelas : '']
                    .filter(Boolean),
                palheiro: normalizar([f.desc, cartao, cs.cat, cs.sub, pessoas.join(' '), rotuloMes(f.mes_fatura), MESES_LONGOS[parseInt((f.mes_fatura || '0000-01').slice(5), 10) - 1],
                    textoValor(f.valor_parcela), parcelado ? f.parcela_atual + '/' + f.total_parcelas + ' ' + f.total_parcelas + 'x' : '', f.fixo ? 'fixo' : '', 'cartao fatura'].join(' ')),
            });
        });
        (d.pontuais || []).forEach(g => {
            const cs = nomeCategoria(g.cat_id, g.subcat_id, d.categorias);
            const pessoas = nomePessoas(g.divisao, d.pessoas);
            const fixo = !!g.origem_regra;
            itens.push({
                tipo: fixo ? 'fixo' : 'pontual', id: g.id, grupo: g.id, parcela: 1, total_parcelas: 1, titulo: g.desc,
                valor: Number(g.valor) || 0, mes: g.mes_ref, painel: fixo ? 'fixos' : 'pontuais', quando: g.data || '',
                sub: [fixo ? 'gasto fixo' : 'gasto pontual', cs.cat + (cs.sub ? ' › ' + cs.sub : ''), pessoas.join(', ')].filter(Boolean),
                palheiro: normalizar([g.desc, cs.cat, cs.sub, pessoas.join(' '), rotuloMes(g.mes_ref), MESES_LONGOS[parseInt((g.mes_ref || '0000-01').slice(5), 10) - 1],
                    textoValor(g.valor), fixo ? 'fixo' : 'pontual', 'dinheiro pix'].join(' ')),
            });
        });
        ((d.transacoes) || []).forEach(t => {
            const mes = (t.data || '').slice(0, 7);
            itens.push({
                tipo: 'entrada', id: t.id, grupo: t.id, parcela: 1, total_parcelas: 1, titulo: t.desc, valor: Number(t.valor) || 0,
                mes: mes, painel: 'entradas', quando: t.data || '', sub: [t.origem_regra ? 'entrada fixa' : 'entrada'],
                palheiro: normalizar([t.desc, rotuloMes(mes), MESES_LONGOS[parseInt((mes || '0000-01').slice(5), 10) - 1], textoValor(t.valor), 'entrada recebido ganho'].join(' ')),
            });
        });
        return itens;
    }

    /* d = {faturas, pontuais, transacoes, cartoes, categorias, pessoas};  mesAtual = 'YYYY-MM' (só desempata).
       Retorna {itens:[...], total:n}. Parcelas da mesma compra viram UMA linha (a mais próxima do mês atual). */
    function buscar(termo, d, mesAtual) {
        const termos = normalizar(termo).split(/\s+/).filter(Boolean);
        if (!termos.length) return { itens: [], total: 0 };
        const achados = montarItens(d).filter(i => casa(termos, i.palheiro));
        const dist = ym => Math.abs((parseInt((ym || '0000-00').slice(0, 4), 10) * 12 + parseInt((ym || '0000-00').slice(5), 10)) -
            (parseInt((mesAtual || '0000-00').slice(0, 4), 10) * 12 + parseInt((mesAtual || '0000-00').slice(5), 10)));
        const porGrupo = new Map();
        achados.forEach(i => {
            const chave = i.tipo + '|' + i.grupo;
            const g = porGrupo.get(chave);
            if (!g) porGrupo.set(chave, { rep: i, outras: 0 });
            else { g.outras++; if (dist(i.mes) < dist(g.rep.mes)) g.rep = i; }
        });
        const itens = [...porGrupo.values()].map(g => Object.assign({}, g.rep, { outras: g.outras }));
        const primeiro = termos[0];
        itens.sort((a, b) => {
            const ta = normalizar(a.titulo).includes(primeiro) ? 0 : 1, tb = normalizar(b.titulo).includes(primeiro) ? 0 : 1;
            return ta - tb || dist(a.mes) - dist(b.mes) || (b.quando || '').localeCompare(a.quando || '');
        });
        return { itens: itens.slice(0, MAX_RESULTADOS), total: itens.length };
    }

    global.BuscaPura = { normalizar, buscar, rotuloMes, montarItens };

    /* ---------------- Parte 2: a barra no topo ---------------- */
    if (typeof document === 'undefined') return;

    const ICONES = { fatura: '<svg class="ic"><use href="#i-cartao"/></svg>', fixo_cartao: '<svg class="ic"><use href="#i-fixos"/></svg>', pontual: '<svg class="ic"><use href="#i-pontual"/></svg>', fixo: '<svg class="ic"><use href="#i-fixos"/></svg>', entrada: '<svg class="ic"><use href="#i-entrada"/></svg>' };
    let resultados = [];
    let ativo = -1;

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const moeda = v => (typeof formatarMoeda === 'function' ? formatarMoeda(v) : 'R$ ' + Number(v).toFixed(2));

    function dados() {
        return { faturas: db_faturas, pontuais: db_gastos_pontuais, transacoes: db.transacoes, cartoes: db_cartoes, categorias: db_categorias, pessoas: db_pessoas };
    }
    function mesAtual() {
        return dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
    }
    function caixa() { return document.getElementById('buscaResultados'); }

    function desenhar(termo) {
        const box = caixa();
        if (!box) return;
        if (!termo.trim()) { box.classList.add('hidden'); resultados = []; return; }
        const r = buscar(termo, dados(), mesAtual());
        resultados = r.itens; ativo = resultados.length ? 0 : -1;
        if (!resultados.length) {
            box.innerHTML = '<div class="busca-vazio">Nada encontrado para “' + esc(termo) + '”. Tente outra palavra, um valor (129,90) ou o nome do cartão.</div>';
        } else {
            box.innerHTML = resultados.map((i, n) =>
                '<div class="busca-item' + (n === ativo ? ' ativo' : '') + '" data-n="' + n + '" role="option">' +
                '<span class="busca-ico">' + (ICONES[i.tipo] || '•') + '</span>' +
                '<span class="busca-meio"><span class="busca-tit">' + esc(i.titulo) + '</span>' +
                '<span class="busca-sub">' + esc(BuscaPura.rotuloMes(i.mes)) + ' · ' + i.sub.map(esc).join(' · ') + (i.outras ? ' · +' + i.outras + ' parcelas' : '') + '</span></span>' +
                '<span class="busca-valor">' + moeda(i.valor) + '</span></div>').join('') +
                (r.total > resultados.length ? '<div class="busca-vazio">Mostrando ' + resultados.length + ' de ' + r.total + '. Digite mais para refinar.</div>' : '');
        }
        box.classList.remove('hidden');
    }

    function marcar(n) {
        const box = caixa();
        if (!box || !resultados.length) return;
        ativo = (n + resultados.length) % resultados.length;
        box.querySelectorAll('.busca-item').forEach((el, i) => el.classList.toggle('ativo', i === ativo));
        const el = box.querySelector('.busca-item.ativo');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }

    function abrirResultado(i) {
        if (!i) return;
        const [a, m] = i.mes.split('-').map(Number);
        dataAtual = new Date(a, m - 1, 1);
        renderizarApp();
        painelAberto = null;                 // força abrir (senão clicar no painel já aberto o fecharia)
        abrirPainel(i.painel);
        fechar(true);
        setTimeout(() => destacarLinha(i), 60);
    }

    /* Acha na tela a linha do item escolhido (pelo código dele nos botões da linha) e a faz piscar. */
    function destacarLinha(i) {
        if (!i || i.id == null) return;
        const chave = "'" + i.id + "'";
        const alvo = [...document.querySelectorAll('[onclick],[onchange]')].find(el =>
            ((el.getAttribute('onclick') || '') + (el.getAttribute('onchange') || '')).includes(chave) && !el.closest('#buscaResultados'));
        if (!alvo) return;
        let linha = alvo.closest('[onclick*="toggleAcoesItem"]') || alvo.closest('.item');
        if (!linha) {                                   // sobe até o primeiro bloco que já mostra o nome do item
            linha = alvo;
            while (linha.parentElement && linha.parentElement !== document.body && !(linha.innerText || '').includes(i.titulo)) linha = linha.parentElement;
        }
        if (linha.scrollIntoView) linha.scrollIntoView({ block: 'center', behavior: 'smooth' });
        linha.classList.remove('destaque-busca');
        void linha.offsetWidth;
        linha.classList.add('destaque-busca');
        setTimeout(() => linha.classList.remove('destaque-busca'), 2600);
    }

    function fechar(limpar) {
        const box = caixa(), inp = document.getElementById('buscaGlobal');
        if (box) box.classList.add('hidden');
        if (limpar && inp) { inp.value = ''; inp.blur(); }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const inp = document.getElementById('buscaGlobal'), box = caixa();
        if (!inp || !box) return;
        inp.addEventListener('input', () => desenhar(inp.value));
        inp.addEventListener('focus', () => { if (inp.value.trim()) desenhar(inp.value); });
        inp.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); marcar(ativo + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); marcar(ativo - 1); }
            else if (e.key === 'Enter') { e.preventDefault(); abrirResultado(resultados[ativo]); }
            else if (e.key === 'Escape') fechar(true);
        });
        box.addEventListener('mousedown', e => {          // mousedown: acontece antes de o campo perder o foco
            const el = e.target.closest('.busca-item');
            if (el) { e.preventDefault(); abrirResultado(resultados[Number(el.dataset.n)]); }
        });
        document.addEventListener('mousedown', e => {
            if (!e.target.closest('.busca-area')) fechar(false);
        });
    });
})(typeof window !== 'undefined' ? window : globalThis);
