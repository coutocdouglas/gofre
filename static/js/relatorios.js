/* Relatórios e Fechar mês.
   Regras da casa: só entra a PARTE DA PESSOA PRINCIPAL (gastos de terceiros não aparecem aqui) e o mês é o da fatura,
   igual ao Dashboard.
   Parte 1 (RelatoriosPuro): contas puras, testadas sem navegador.  Parte 2: as telas (gráficos em SVG, sem biblioteca). */
(function (global) {
    'use strict';

    const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const MESES_LONGOS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const MES_MINIMO = '2026-04';          // o programa não navega antes de abril/2026
    const SEM_CATEGORIA = 'Sem categoria';

    // ------------------------------------------------------------------ meses
    function rotuloMes(ym) { return MESES[parseInt(ym.slice(5), 10) - 1] + '/' + ym.slice(2, 4); }
    function rotuloLongo(ym) { return MESES_LONGOS[parseInt(ym.slice(5), 10) - 1] + ' de ' + ym.slice(0, 4); }
    function somarMes(ym, n) {
        const d = new Date(parseInt(ym.slice(0, 4), 10), parseInt(ym.slice(5), 10) - 1 + n, 1);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
    function intervalo(fim, qtd, minimo) {
        const min = minimo || MES_MINIMO;
        const lista = [];
        for (let i = qtd - 1; i >= 0; i--) {
            const m = somarMes(fim, -i);
            if (m >= min) lista.push(m);
        }
        return lista;
    }

    // ------------------------------------------------------------------ contas
    function minhaParte(divisao, idPrincipal) {
        const d = (divisao || []).find(x => x.pessoa_id === idPrincipal);
        return d ? (Number(d.valor) || 0) : 0;
    }

    /* d: { faturas, pontuais, transacoes, categorias, idPrincipal }  ->  números do mês (só a parte do principal) */
    function calcularMes(d, ym) {
        const id = d.idPrincipal;
        const itens = [];
        let fixos = 0, pontuais = 0, cartao = 0;
        const categorias = {};

        function somarCat(item, valor) {
            const chave = item.cat_id || '';
            const c = categorias[chave] || (categorias[chave] = { total: 0, subs: {} });
            c.total += valor;
            const sub = item.subcat_id || '';
            c.subs[sub] = (c.subs[sub] || 0) + valor;
        }
        (d.pontuais || []).forEach(g => {
            if (g.mes_ref !== ym) return;
            const v = minhaParte(g.divisao, id);
            if (g.origem_regra) fixos += v; else pontuais += v;
            if (v) { somarCat(g, v); itens.push({ desc: g.desc, valor: v, tipo: g.origem_regra ? 'Fixo' : 'Pontual', cat_id: g.cat_id || '', data: g.data || '' }); }
        });
        (d.faturas || []).forEach(f => {
            if (f.mes_fatura !== ym) return;
            const v = minhaParte(f.divisao, id);
            cartao += v;
            if (v) {
                somarCat(f, v);
                const parc = (f.total_parcelas || 1) > 1 ? ' (' + f.parcela_atual + '/' + f.total_parcelas + ')' : '';
                itens.push({ desc: f.desc + parc, valor: v, tipo: f.fixo ? 'Fixo no cartão' : 'Cartão', cat_id: f.cat_id || '', data: f.data_compra || '' });
            }
        });
        const entradas = (d.transacoes || []).filter(t => t.data && t.data.startsWith(ym)).reduce((s, t) => s + (Number(t.valor) || 0), 0);
        const gastos = fixos + pontuais + cartao;      // fixos pagos no cartão já estão em "cartao": não somam duas vezes
        return { mes: ym, fixos, pontuais, cartao, gastos, entradas, saldo: entradas - gastos, categorias, itens };
    }

    function calcularSerie(d, meses) { return meses.map(m => calcularMes(d, m)); }

    function variacao(atual, anterior) {
        const dif = (atual || 0) - (anterior || 0);
        return { dif, pct: anterior ? (dif / Math.abs(anterior)) * 100 : null };
    }

    function nomeCategoria(catId, categorias) {
        if (!catId) return SEM_CATEGORIA;
        const c = (categorias || []).find(x => x.id === catId);
        return c ? c.nome : SEM_CATEGORIA;
    }
    function nomeSub(catId, subId, categorias) {
        const c = (categorias || []).find(x => x.id === catId);
        const s = c && (c.subcategorias || []).find(x => x.id === subId);
        return s ? s.nome : 'Outros';
    }

    /* Linhas "categoria x meses", da que mais pesou no período para a que menos pesou. */
    function categoriasDaSerie(serie, categorias) {
        const ids = new Set();
        serie.forEach(m => Object.keys(m.categorias).forEach(k => ids.add(k)));
        const linhas = [...ids].map(catId => {
            const valores = serie.map(m => (m.categorias[catId] || { total: 0 }).total);
            const n = valores.length;
            return {
                catId, nome: nomeCategoria(catId, categorias), valores, total: valores.reduce((a, b) => a + b, 0),
                variacao: n >= 2 ? variacao(valores[n - 1], valores[n - 2]) : { dif: 0, pct: null },
            };
        });
        return linhas.sort((a, b) => b.total - a.total);
    }

    function subcategoriasDoMes(mesCalc, catId, categorias) {
        const c = mesCalc.categorias[catId];
        if (!c) return [];
        return Object.keys(c.subs).map(s => ({ nome: nomeSub(catId, s, categorias), valor: c.subs[s] })).sort((a, b) => b.valor - a.valor);
    }

    function maioresGastos(mesCalc, n) {
        return mesCalc.itens.slice().sort((a, b) => b.valor - a.valor).slice(0, n || 10);
    }

    /* O que ainda está em aberto no mês (só os SEUS pagamentos): gastos não pagos, faturas não pagas, itens sem categoria. */
    function pendencias(d, ym) {
        const id = d.idPrincipal;
        const gastosNaoPagos = (d.pontuais || []).filter(g => g.mes_ref === ym && !g.pago && minhaParte(g.divisao, id) > 0)
            .map(g => ({ desc: g.desc, valor: minhaParte(g.divisao, id) }));
        const porCartao = {};
        (d.faturas || []).filter(f => f.mes_fatura === ym && minhaParte(f.divisao, id) > 0).forEach(f => {
            porCartao[f.cartao_id] = (porCartao[f.cartao_id] || 0) + minhaParte(f.divisao, id);
        });
        const faturasNaoPagas = Object.keys(porCartao).filter(cid => {
            const p = (d.pagamentosFatura || []).find(x => x.cartao_id === cid && x.mes === ym);
            return !(p && p.pago);
        }).map(cid => ({ cartao: ((d.cartoes || []).find(c => c.id === cid) || {}).nome || 'Cartão', valor: porCartao[cid] }));
        const semCategoria =
            (d.pontuais || []).filter(g => g.mes_ref === ym && !g.cat_id && minhaParte(g.divisao, id) > 0).length +
            (d.faturas || []).filter(f => f.mes_fatura === ym && !f.cat_id && minhaParte(f.divisao, id) > 0).length;
        return { gastosNaoPagos, faturasNaoPagas, semCategoria };
    }

    /* A "foto" guardada ao fechar o mês. */
    function resumoParaSalvar(mesCalc, categorias) {
        return {
            fixos: mesCalc.fixos, pontuais: mesCalc.pontuais, cartao: mesCalc.cartao, saldo: mesCalc.saldo,
            categorias: Object.keys(mesCalc.categorias).map(k => ({ nome: nomeCategoria(k, categorias), total: mesCalc.categorias[k].total }))
                .sort((a, b) => b.total - a.total),
        };
    }

    /* Mudou algo depois de fechar? (centavos não contam) */
    function mudouDesdeOFechamento(mesCalc, fechado) {
        const difGastos = mesCalc.gastos - (fechado.gastos || 0);
        const difEntradas = mesCalc.entradas - (fechado.entradas || 0);
        return { difGastos, difEntradas, mudou: Math.abs(difGastos) >= 0.01 || Math.abs(difEntradas) >= 0.01 };
    }

    const API = { rotuloMes, rotuloLongo, somarMes, intervalo, minhaParte, calcularMes, calcularSerie, variacao, categoriasDaSerie,
        subcategoriasDoMes, maioresGastos, pendencias, resumoParaSalvar, mudouDesdeOFechamento, nomeCategoria, SEM_CATEGORIA, MES_MINIMO };
    global.RelatoriosPuro = API;

    // ================================================================== telas (só no navegador)
    if (typeof document === 'undefined') return;

    const estado = { aba: 'comparar', janela: 6, catSel: null, cats: [] };
    const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const moeda = v => (typeof formatarMoeda === 'function' ? formatarMoeda(v) : 'R$ ' + (Number(v) || 0).toFixed(2));

    function mesAtualStr() { return dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0'); }
    function hojeYM() { const h = new Date(); return h.getFullYear() + '-' + String(h.getMonth() + 1).padStart(2, '0'); }
    function dados() {
        const principal = db_pessoas.find(p => p.tipo === 'principal');
        return {
            faturas: db_faturas, pontuais: db_gastos_pontuais, transacoes: db.transacoes, categorias: db_categorias,
            cartoes: db_cartoes, pagamentosFatura: db_pagamentos_fatura, idPrincipal: principal ? principal.id : 'p_principal',
        };
    }
    function curto(v) {
        const n = Math.abs(v);
        const t = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',') + ' mil' : String(Math.round(n));
        return (v < 0 ? '-' : '') + t;
    }
    function textoVar(v, inverter) {            // inverter: para gastos, subir é ruim (vermelho)
        if (!v || Math.abs(v.dif) < 0.005) return '<span style="color:var(--text-muted)">igual</span>';
        const sobe = v.dif > 0;
        const ruim = inverter ? sobe : !sobe;
        const cor = ruim ? 'var(--danger)' : 'var(--success)';
        return '<span style="color:' + cor + ';font-weight:600">' + (sobe ? '<svg class="ic ic-t"><use href="#i-chevu"/></svg>' : '<svg class="ic ic-t"><use href="#i-chevd"/></svg>') + moeda(Math.abs(v.dif)) +
            (v.pct !== null ? ' (' + Math.abs(v.pct).toFixed(0) + '%)' : '') + '</span>';
    }

    // ---- gráficos (SVG)
    function graficoBarras(series, opcoes) {
        // series: [{rotulo, valores:[a,b], futuro}] ; opcoes.cores:[cor1,cor2]
        const W = 1100, H = 250, base = H - 34, topo = 22, esq = 8;
        const maximo = Math.max(1, ...series.flatMap(s => s.valores));
        const n = series.length, larg = (W - esq * 2) / n;
        const nb = series[0].valores.length, bw = Math.min(40, (larg - 20) / nb);
        let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" role="img">';
        [0.25, 0.5, 0.75, 1].forEach(f => {
            const y = base - (base - topo) * f;
            svg += '<line x1="' + esq + '" x2="' + (W - esq) + '" y1="' + y + '" y2="' + y + '" stroke="var(--w-08)" stroke-width="1"/>';
        });
        series.forEach((s, i) => {
            const cx = esq + larg * i + larg / 2;
            s.valores.forEach((v, j) => {
                const h = Math.max(v > 0 ? 2 : 0, (base - topo) * (v / maximo));
                const x = cx - (bw * nb) / 2 + bw * j + (j ? 2 : 0);
                const futuro = s.futuro;
                svg += '<rect x="' + x + '" y="' + (base - h) + '" width="' + (bw - 2) + '" height="' + h + '" rx="4" fill="' + opcoes.cores[j] +
                    '" opacity="' + (futuro ? 0.45 : 0.9) + '"' + (futuro ? ' stroke="' + opcoes.cores[j] + '" stroke-dasharray="3 3"' : '') + '/>';
                if (v > 0) svg += '<text x="' + (x + (bw - 2) / 2) + '" y="' + (base - h - 5) + '" text-anchor="middle" font-size="10" fill="var(--text-muted)">' + curto(v) + '</text>';
            });
            svg += '<text x="' + cx + '" y="' + (H - 12) + '" text-anchor="middle" font-size="11" fill="var(--text-main)">' + esc(s.rotulo) + (s.futuro ? '*' : '') + '</text>';
        });
        return svg + '</svg>';
    }

    function legenda(itens) {
        return '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--text-muted);margin-top:8px">' +
            itens.map(i => '<span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:' + i[1] + ';margin-right:5px"></span>' + i[0] + '</span>').join('') + '</div>';
    }

    const CAIXA = 'background:var(--w-03);border:1px solid var(--w-08);border-radius:16px;padding:20px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,0.2),inset 0 1px 0 var(--w-06);';
    const TITULO = 'font-size:10px;color:var(--text-muted);letter-spacing:0.8px;font-weight:700;margin-bottom:14px;';
    const TH = 'text-align:right;padding:8px 10px;font-size:11px;color:var(--text-muted);font-weight:600;white-space:nowrap;';
    const TD = 'text-align:right;padding:8px 10px;font-size:12px;border-top:1px solid var(--w-06);white-space:nowrap;';

    function abas() {
        const b = (id, rot) => '<button class="btn-action' + (estado.aba === id ? ' active' : '') + '" style="margin:0" onclick="Relatorios.aba(\'' + id + '\')">' + rot + '</button>';
        return '<div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap">' + b('comparar', '<svg class="ic ic-t"><use href="#i-relat"/></svg>Comparar meses') + b('fechar', '<svg class="ic ic-t"><use href="#i-lock"/></svg>Fechar mês') + '</div>';
    }
    function cabecalho(sub) {
        return '<div style="margin-bottom:18px;border-bottom:1px solid var(--w-08);padding-bottom:14px;">' +
            '<h3 style="color:var(--primary);font-size:20px;margin:0;font-weight:700;"><svg class="ic ic-t"><use href="#i-relat"/></svg>Relatórios</h3>' +
            '<p style="color:var(--text-muted);font-size:12px;margin-top:4px;">' + sub + '</p></div>';
    }

    // ---- aba 1: comparar meses
    function telaComparar(d) {
        const fim = mesAtualStr();
        const meses = intervalo(fim, estado.janela);
        const serie = calcularSerie(d, meses);
        const hoje = hojeYM();
        const futuro = m => m > hoje;
        const botoesJanela = [3, 6, 12].map(n => '<button class="btn-action' + (estado.janela === n ? ' active' : '') +
            '" style="margin:0;padding:6px 12px;font-size:12px" onclick="Relatorios.janela(' + n + ')">' + n + ' meses</button>').join('');

        let html = cabecalho('Só os seus gastos (a sua parte), pelo mês da fatura — terminando em <b>' + rotuloLongo(fim) + '</b>. Use as setas do topo para mudar o mês final.');
        html += abas();
        html += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:16px"><span style="font-size:12px;color:var(--text-muted)">Período:</span>' + botoesJanela + '</div>';

        // gráfico entradas x gastos
        html += '<div style="' + CAIXA + '"><div style="' + TITULO + '">ENTRADAS × MEUS GASTOS, MÊS A MÊS</div>' +
            graficoBarras(serie.map(m => ({ rotulo: rotuloMes(m.mes), valores: [m.entradas, m.gastos], futuro: futuro(m.mes) })), { cores: ['var(--success)', 'var(--danger)'] }) +
            legenda([['Entradas', 'var(--success)'], ['Meus gastos', 'var(--danger)']]) +
            (serie.some(m => futuro(m.mes)) ? '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">* mês que ainda não chegou: só aparecem parcelas e lançamentos já feitos (previsão).</div>' : '') + '</div>';

        // tabela mês a mês
        let linhas = '';
        serie.forEach((m, i) => {
            const ant = i > 0 ? serie[i - 1] : null;
            linhas += '<tr><td style="' + TD + 'text-align:left;font-weight:600">' + rotuloMes(m.mes) + (futuro(m.mes) ? ' *' : '') + '</td>' +
                '<td style="' + TD + '">' + (m.entradas ? moeda(m.entradas) : '—') + '</td>' +
                '<td style="' + TD + '">' + moeda(m.fixos) + '</td><td style="' + TD + '">' + moeda(m.pontuais) + '</td><td style="' + TD + '">' + moeda(m.cartao) + '</td>' +
                '<td style="' + TD + 'font-weight:700">' + moeda(m.gastos) + '</td>' +
                '<td style="' + TD + 'color:' + (m.saldo >= 0 ? 'var(--success)' : 'var(--danger)') + '">' + (m.entradas || m.gastos ? moeda(m.saldo) : '—') + '</td>' +
                '<td style="' + TD + '">' + (ant ? textoVar(variacao(m.gastos, ant.gastos), true) : '<span style="color:var(--text-muted)">—</span>') + '</td></tr>';
        });
        html += '<div style="' + CAIXA + 'overflow-x:auto"><div style="' + TITULO + '">NÚMEROS DE CADA MÊS</div><table style="width:100%;border-collapse:collapse"><thead><tr>' +
            '<th style="' + TH + 'text-align:left">Mês</th><th style="' + TH + '">Entradas</th><th style="' + TH + '">Fixos</th><th style="' + TH + '">Pontuais</th><th style="' + TH + '">Cartão</th>' +
            '<th style="' + TH + '">Meus gastos</th><th style="' + TH + '">Saldo</th><th style="' + TH + '">Gastos vs mês anterior</th></tr></thead><tbody>' + linhas + '</tbody></table></div>';

        // categorias x meses
        const cats = categoriasDaSerie(serie, d.categorias);
        if (!cats.length) {
            html += '<div style="' + CAIXA + '"><p style="color:var(--text-muted);font-size:13px;margin:0">Ainda não há gastos com categoria neste período.</p></div>';
            return html;
        }
        estado.cats = cats;
        if (estado.catSel === null || !cats.find(c => c.catId === estado.catSel)) estado.catSel = cats[0].catId;
        const maxCel = Math.max(1, ...cats.flatMap(c => c.valores));
        let tcat = '<thead><tr><th style="' + TH + 'text-align:left">Categoria</th>' + serie.map(m => '<th style="' + TH + '">' + rotuloMes(m.mes) + '</th>').join('') +
            '<th style="' + TH + '">Último vs anterior</th></tr></thead><tbody>';
        cats.forEach(c => {
            const sel = c.catId === estado.catSel;
            tcat += '<tr style="cursor:pointer;' + (sel ? 'background:var(--w-06);' : '') + '" onclick="Relatorios.categoria(' + cats.indexOf(c) + ')">' +
                '<td style="' + TD + 'text-align:left;font-weight:' + (sel ? 700 : 500) + '">' + esc(c.nome) + '</td>' +
                c.valores.map(v => '<td style="' + TD + (v ? 'background:color-mix(in srgb, var(--accent) ' + Math.round(8 + 32 * (v / maxCel)) + '%, transparent);' : 'color:var(--text-muted);') + '">' + (v ? moeda(v) : '—') + '</td>').join('') +
                '<td style="' + TD + '">' + (serie.length >= 2 ? textoVar(c.variacao, true) : '—') + '</td></tr>';
        });
        tcat += '</tbody>';
        html += '<div style="' + CAIXA + 'overflow-x:auto"><div style="' + TITULO + '">EVOLUÇÃO POR CATEGORIA (toque numa linha para ver o gráfico dela)</div><table style="width:100%;border-collapse:collapse">' + tcat + '</table></div>';

        const escolhida = cats.find(c => c.catId === estado.catSel);
        const ultimo = serie[serie.length - 1];
        const subs = subcategoriasDoMes(ultimo, estado.catSel, d.categorias);
        html += '<div style="' + CAIXA + '"><div style="' + TITULO + '">' + esc(escolhida.nome.toUpperCase()) + ' — MÊS A MÊS</div>' +
            graficoBarras(serie.map((m, i) => ({ rotulo: rotuloMes(m.mes), valores: [escolhida.valores[i]], futuro: futuro(m.mes) })), { cores: ['var(--accent)'] }) +
            (subs.length > 1 || (subs.length === 1 && subs[0].nome !== 'Outros') ?
                '<div style="margin-top:14px;font-size:11px;color:var(--text-muted);font-weight:700;letter-spacing:0.6px">SUBCATEGORIAS EM ' + rotuloMes(ultimo.mes).toUpperCase() + '</div>' +
                subs.map(s => '<div style="display:flex;justify-content:space-between;padding:6px 10px;margin-top:4px;background:var(--w-03);border-radius:6px;font-size:12px"><span>' + esc(s.nome) + '</span><b>' + moeda(s.valor) + '</b></div>').join('') : '') + '</div>';
        return html;
    }

    // ---- aba 2: fechar mês
    function fechadoDe(ym) { return (db_meses_fechados || []).find(x => x.mes === ym); }

    function telaFechar(d) {
        const ym = mesAtualStr();
        const m = calcularMes(d, ym);
        const ant = calcularMes(d, somarMes(ym, -1));
        const temAnterior = somarMes(ym, -1) >= MES_MINIMO;
        const pend = pendencias(d, ym);
        const fechado = fechadoDe(ym);
        const top = maioresGastos(m, 10);
        const cats = categoriasDaSerie([ant, m], d.categorias).filter(c => c.valores[1] > 0 || c.valores[0] > 0).sort((a, b) => b.valores[1] - a.valores[1]).slice(0, 6);

        let html = cabecalho('Resumo de <b>' + rotuloLongo(ym) + '</b> (só a sua parte). Use as setas do topo para escolher o mês.') + abas();

        // situação do fechamento
        if (fechado) {
            const mud = mudouDesdeOFechamento(m, fechado);
            const quando = new Date(fechado.fechado_em);
            html += '<div style="background:color-mix(in srgb, var(--success) 10%, transparent);border:1px solid color-mix(in srgb, var(--success) 25%, transparent);border-radius:16px;padding:16px;margin-bottom:20px">' +
                '<b style="color:var(--success)"><svg class="ic ic-t"><use href="#i-lock"/></svg>Mês fechado</b> em ' + (isNaN(quando) ? '' : quando.toLocaleDateString('pt-BR') + ' às ' + quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })) +
                ' — gastos de ' + moeda(fechado.gastos) + ', entradas de ' + moeda(fechado.entradas) + '.' +
                (mud.mudou ? '<div style="margin-top:8px;color:var(--warning);font-size:13px"><svg class="ic ic-t"><use href="#i-alert"/></svg>Mudou desde o fechamento: gastos ' + (mud.difGastos >= 0 ? '+' : '−') + moeda(Math.abs(mud.difGastos)) +
                    (Math.abs(mud.difEntradas) >= 0.01 ? ', entradas ' + (mud.difEntradas >= 0 ? '+' : '−') + moeda(Math.abs(mud.difEntradas)) : '') + '.</div>' : '<div style="margin-top:6px;font-size:12px;color:var(--text-muted)">Nada mudou desde o fechamento.</div>') +
                '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
                (mud.mudou ? '<button class="btn-blue" style="margin:0;width:auto;padding:10px 22px" onclick="Relatorios.fechar()">Atualizar fechamento</button>' : '') +
                '<button class="btn-action" style="margin:0" onclick="Relatorios.reabrir()">Reabrir mês</button></div></div>';
        }

        // números principais
        const blocos = [['<svg class="ic"><use href="#i-entrada"/></svg>', 'ENTRADAS', m.entradas, 'var(--success)'], ['<svg class="ic"><use href="#i-receipt"/></svg>', 'MEUS GASTOS', m.gastos, 'var(--danger)'], ['<svg class="ic"><use href="#i-scale"/></svg>', 'SALDO', m.saldo, m.saldo >= 0 ? 'var(--success)' : 'var(--danger)']];
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px">' +
            blocos.map(b => '<div style="background:var(--w-04);border:1px solid var(--w-09);border-radius:16px;padding:18px"><div style="font-size:10px;color:var(--text-muted);letter-spacing:0.8px;font-weight:700;margin-bottom:6px">' +
                b[0] + ' ' + b[1] + '</div><div style="font-size:22px;font-weight:700;color:' + b[3] + '">' + moeda(b[2]) + '</div>' +
                (b[1] === 'MEUS GASTOS' && temAnterior ? '<div style="font-size:11px;margin-top:5px">' + textoVar(variacao(m.gastos, ant.gastos), true) + ' vs ' + rotuloMes(ant.mes) + '</div>' : '') + '</div>').join('') + '</div>';
        html += '<div style="font-size:12px;color:var(--text-muted);margin:-8px 0 20px">Fixos ' + moeda(m.fixos) + ' · Pontuais ' + moeda(m.pontuais) + ' · Cartão ' + moeda(m.cartao) + '</div>';

        // pendências
        const itensPend = [];
        pend.faturasNaoPagas.forEach(f => itensPend.push('Fatura do <b>' + esc(f.cartao) + '</b> ainda não marcada como paga (' + moeda(f.valor) + ')'));
        if (pend.gastosNaoPagos.length) itensPend.push('<b>' + pend.gastosNaoPagos.length + '</b> gasto(s) fixo/pontual não marcado(s) como pago(s): ' +
            pend.gastosNaoPagos.slice(0, 4).map(g => esc(g.desc)).join(', ') + (pend.gastosNaoPagos.length > 4 ? '…' : ''));
        if (pend.semCategoria) itensPend.push('<b>' + pend.semCategoria + '</b> lançamento(s) sem categoria (atrapalham os relatórios)');
        html += '<div style="' + CAIXA + '"><div style="' + TITULO + '">ANTES DE FECHAR — CONFIRA</div>' +
            (itensPend.length ? itensPend.map(t => '<div style="padding:8px 10px;margin-bottom:6px;background:var(--w-03);border-radius:8px;font-size:13px"><svg class="ic ic-t"><use href="#i-alert"/></svg>' + t + '</div>').join('') +
                '<div style="font-size:11px;color:var(--text-muted);margin-top:6px">São só avisos: você pode fechar mesmo assim.</div>' :
                '<div style="font-size:13px;color:var(--success)"><svg class="ic ic-t"><use href="#i-checkc"/></svg>Tudo em dia: faturas e gastos marcados como pagos e nenhum lançamento sem categoria.</div>') + '</div>';

        // categorias
        if (cats.length) {
            html += '<div style="' + CAIXA + '"><div style="' + TITULO + '">PRINCIPAIS CATEGORIAS' + (temAnterior ? ' (VS ' + rotuloMes(ant.mes).toUpperCase() + ')' : '') + '</div>' +
                cats.map(c => '<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13px;border-top:1px solid var(--w-06)"><span>' + esc(c.nome) + '</span><span><b>' + moeda(c.valores[1]) + '</b>' +
                    (temAnterior ? ' &nbsp; ' + textoVar(c.variacao, true) : '') + '</span></div>').join('') + '</div>';
        }

        // maiores gastos
        if (top.length) {
            html += '<div style="' + CAIXA + '"><div style="' + TITULO + '">10 MAIORES GASTOS DO MÊS</div>' +
                top.map((g, i) => '<div style="display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13px;border-top:1px solid var(--w-06)"><span>' + (i + 1) + '. ' + esc(g.desc) +
                    ' <span style="color:var(--text-muted);font-size:11px">· ' + esc(g.tipo) + ' · ' + esc(nomeCategoria(g.cat_id, d.categorias)) + '</span></span><b>' + moeda(g.valor) + '</b></div>').join('') + '</div>';
        }

        // ações
        html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">' +
            (!fechado ? '<button class="btn-blue" style="margin:0;width:auto;padding:10px 22px" onclick="Relatorios.fechar()"><svg class="ic ic-t"><use href="#i-lock"/></svg>Fechar ' + rotuloMes(ym) + '</button>' : '') +
            '<button class="btn-action" style="margin:0" onclick="Relatorios.copiar()"><svg class="ic ic-t"><use href="#i-clipboard"/></svg>Copiar resumo</button></div>' +
            '<p style="font-size:11px;color:var(--text-muted)">Fechar não trava nada: só guarda uma “foto” dos números de hoje para você comparar depois e avisar se algo mudar. Dá para desfazer com Ctrl+Z.</p>';
        return html;
    }

    function textoDoResumo(d) {
        const ym = mesAtualStr(), m = calcularMes(d, ym), ant = calcularMes(d, somarMes(ym, -1));
        const L = ['Resumo de ' + rotuloLongo(ym), '',
            'Entradas: ' + moeda(m.entradas), 'Meus gastos: ' + moeda(m.gastos) + (somarMes(ym, -1) >= MES_MINIMO ? ' (mês anterior: ' + moeda(ant.gastos) + ')' : ''),
            '  Fixos: ' + moeda(m.fixos) + ' | Pontuais: ' + moeda(m.pontuais) + ' | Cartão: ' + moeda(m.cartao), 'Saldo: ' + moeda(m.saldo), '', 'Principais categorias:'];
        categoriasDaSerie([m], d.categorias).slice(0, 6).forEach(c => L.push('  ' + c.nome + ': ' + moeda(c.valores[0])));
        L.push('', 'Maiores gastos:');
        maioresGastos(m, 10).forEach((g, i) => L.push('  ' + (i + 1) + '. ' + g.desc + ' — ' + moeda(g.valor)));
        return L.join('\n');
    }

    // ---- ações
    const Relatorios = {
        renderizar() {
            const area = document.getElementById('area-exibicao-relatorios');
            if (!area) return;
            area.classList.remove('hidden');
            const d = dados();
            area.innerHTML = estado.aba === 'fechar' ? telaFechar(d) : telaComparar(d);
        },
        aba(a) { estado.aba = a; this.renderizar(); },
        janela(n) { estado.janela = n; this.renderizar(); },
        categoria(i) { if (estado.cats[i]) estado.catSel = estado.cats[i].catId; this.renderizar(); },
        async fechar() {
            const d = dados(), ym = mesAtualStr(), m = calcularMes(d, ym);
            const reg = { mes: ym, fechado_em: new Date().toISOString(), entradas: m.entradas, gastos: m.gastos, resumo: resumoParaSalvar(m, d.categorias) };
            db_meses_fechados = (db_meses_fechados || []).filter(x => x.mes !== ym).concat([reg]);
            await sincronizarMesesFechados();
            if (window.mostrarAviso) window.mostrarAviso('Mês ' + rotuloMes(ym) + ' fechado.', 'sucesso');
            this.renderizar();
        },
        async reabrir() {
            const ym = mesAtualStr();
            if (!window.confirm('Reabrir ' + rotuloLongo(ym) + '? A “foto” guardada será apagada (dá para desfazer com Ctrl+Z).')) return;
            db_meses_fechados = (db_meses_fechados || []).filter(x => x.mes !== ym);
            await sincronizarMesesFechados();
            this.renderizar();
        },
        copiar() {
            const texto = textoDoResumo(dados());
            const ok = () => window.mostrarAviso && window.mostrarAviso('Resumo copiado.', 'sucesso');
            if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(texto).then(ok, () => window.prompt('Copie o resumo:', texto)); return; }
            const ta = document.createElement('textarea'); ta.value = texto; document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); ok(); } catch (e) { window.prompt('Copie o resumo:', texto); }
            ta.remove();
        },
    };
    global.Relatorios = Relatorios;
})(typeof globalThis !== 'undefined' ? globalThis : this);
