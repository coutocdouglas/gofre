/* Análise com IA (aba Relatórios).
   Parte 1 (IAPuro): monta o resumo que a IA recebe — só totais por mês/categoria; nomes de lançamentos só se você marcar.
   Parte 2: a tela. A chave de API fica guardada no computador (o servidor local é quem fala com a IA). */
(function (global) {
    'use strict';
    const R = global.RelatoriosPuro;
    const brl = v => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

    // ------------------------------------------------------------------ Parte 1: o resumo enviado
    function montarContexto(d, o) {
        const qtd = o.qtd || 6, fim = o.fim;
        const meses = R.intervalo(fim, qtd);
        const serie = R.calcularSerie(d, meses);
        const L = [];
        L.push('Período analisado: ' + R.rotuloMes(meses[0]) + ' a ' + R.rotuloMes(meses[meses.length - 1]) + ' (mês atual: ' + R.rotuloMes(fim) + ').');
        L.push('', 'RESUMO POR MÊS (entradas, gastos, saldo; gastos = fixos + pontuais + cartão):');
        serie.forEach(m => L.push('- ' + R.rotuloMes(m.mes) + ': entradas ' + brl(m.entradas) + ' | gastos ' + brl(m.gastos) +
            ' (fixos ' + brl(m.fixos) + ', pontuais ' + brl(m.pontuais) + ', cartão ' + brl(m.cartao) + ') | saldo ' + brl(m.saldo)));
        const cats = R.categoriasDaSerie(serie, d.categorias).slice(0, 12);
        L.push('', 'GASTOS POR CATEGORIA, mês a mês (' + meses.map(R.rotuloMes).join(', ') + '):');
        cats.forEach(c => L.push('- ' + c.nome + ': ' + c.valores.map(brl).join(' | ') + ' | total ' + brl(c.total)));
        const atual = serie[serie.length - 1];
        const orc = (o.orcamentos || []).filter(x => x.mes === fim && !x.subcat_id && Number(x.valor) > 0);
        if (orc.length) {
            L.push('', 'ORÇAMENTO DO MÊS ATUAL (orçado x gasto até agora):');
            orc.forEach(x => {
                const gasto = (atual.categorias[x.cat_id] || { total: 0 }).total;
                L.push('- ' + R.nomeCategoria(x.cat_id, d.categorias) + ': orçado ' + brl(x.valor) + ' | gasto ' + brl(gasto) + ' | ' + (gasto > x.valor ? 'ESTOUROU em ' + brl(gasto - x.valor) : 'sobra ' + brl(x.valor - gasto)));
            });
        }
        const futuros = [1, 2, 3].map(n => R.somarMes(fim, n)).map(ym => R.calcularMes(d, ym)).filter(m => m.gastos > 0);
        if (futuros.length) {
            L.push('', 'COMPROMISSOS JÁ LANÇADOS PARA OS PRÓXIMOS MESES (parcelas e fixos; ainda sem gastos pontuais futuros):');
            futuros.forEach(m => L.push('- ' + R.rotuloMes(m.mes) + ': ' + brl(m.gastos)));
        }
        const pend = R.pendencias(d, fim);
        L.push('', 'PENDÊNCIAS DO MÊS ATUAL: ' + pend.gastosNaoPagos.length + ' gasto(s) ainda não pago(s) (' + brl(pend.gastosNaoPagos.reduce((s, g) => s + g.valor, 0)) + '), ' +
            pend.faturasNaoPagas.length + ' fatura(s) de cartão em aberto (' + brl(pend.faturasNaoPagas.reduce((s, g) => s + g.valor, 0)) + '), ' + pend.semCategoria + ' lançamento(s) sem categoria.');
        if (o.descricoes) {
            L.push('', 'MAIORES LANÇAMENTOS DO MÊS ATUAL (nomes incluídos por escolha do usuário):');
            R.maioresGastos(atual, 15).forEach(g => L.push('- ' + g.desc + ' [' + g.tipo + ', ' + R.nomeCategoria(g.cat_id, d.categorias) + ']: ' + brl(g.valor)));
            const ant = serie.length > 1 ? serie[serie.length - 2] : null;
            if (ant) {
                L.push('', 'MAIORES LANÇAMENTOS DO MÊS ANTERIOR:');
                R.maioresGastos(ant, 8).forEach(g => L.push('- ' + g.desc + ' [' + g.tipo + ']: ' + brl(g.valor)));
            }
        } else {
            L.push('', '(Os nomes dos lançamentos não foram enviados, só totais por categoria.)');
        }
        return L.join('\n');
    }
    global.IAPuro = { montarContexto, brl };

    if (typeof document === 'undefined') return;

    // ------------------------------------------------------------------ Parte 2: a tela
    const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const SUGESTOES = ['Faça um resumo do meu mês', 'Onde posso economizar?', 'O que mudou em relação ao mês passado?', 'Quais gastos fogem do padrão?',
        'Como está meu orçamento?', 'Como ficam os próximos meses com as parcelas?'];
    const AJUDA = {
        claude: { nome: 'Claude', link: 'https://console.anthropic.com/settings/keys', passo: 'Entre em console.anthropic.com, vá em API Keys, crie uma chave e adicione um pouco de crédito (US$ 5 rende muitas análises). A assinatura do site/app é separada da API.' },
        gemini: { nome: 'Gemini', link: 'https://aistudio.google.com/apikey', passo: 'Entre em aistudio.google.com com sua conta Google e clique em "Get API key". Há uso gratuito com limites diários, suficiente para uso pessoal.' },
    };
    const S = { cfg: null, historico: [], carregando: false, qtd: 6, descricoes: false, sugeridas: [], editando: false, modelos: null, erro: '' };

    function dados() {
        const principal = db_pessoas.find(p => p.tipo === 'principal');
        return { faturas: db_faturas, pontuais: db_gastos_pontuais, transacoes: db.transacoes, categorias: db_categorias, cartoes: db_cartoes,
                 pagamentosFatura: db_pagamentos_fatura, idPrincipal: principal ? principal.id : 'p_principal' };
    }
    function contexto() {
        const fim = dataAtual.getFullYear() + '-' + String(dataAtual.getMonth() + 1).padStart(2, '0');
        return montarContexto(dados(), { fim, qtd: S.qtd, descricoes: S.descricoes, orcamentos: db_orcamentos });
    }
    function api(url, corpo) {
        return fetch(url, corpo === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })
            .then(r => r.json().catch(() => ({ ok: false, mensagem: 'Resposta inesperada.' })));
    }
    function md(texto) {                                   // markdown mínimo e seguro: **negrito**, listas "-", títulos "#"
        const linhas = esc(texto).split('\n'); let html = '', lista = false;
        const fmt = t => t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        linhas.forEach(l => {
            const item = l.match(/^\s*[-*•]\s+(.*)/);
            if (item) { if (!lista) { html += '<ul>'; lista = true; } html += '<li>' + fmt(item[1]) + '</li>'; return; }
            if (lista) { html += '</ul>'; lista = false; }
            const tit = l.match(/^#{1,4}\s+(.*)/);
            if (tit) html += '<p><strong>' + fmt(tit[1]) + '</strong></p>'; else if (l.trim()) html += '<p>' + fmt(l) + '</p>';
        });
        return html + (lista ? '</ul>' : '');
    }

    function telaConfig() {
        const c = S.cfg;
        const bloco = prov => {
            const a = AJUDA[prov], p = c[prov];
            return '<div class="ia-card"><div class="ia-linha"><b>' + a.nome + '</b>' + (p.chave_definida ? '<span class="ia-ok">chave salva ' + esc(p.chave) + '</span>' : '<span class="ia-mudo">sem chave</span>') + '</div>' +
                '<p class="ia-mudo">' + a.passo + ' <a href="#" onclick="IA.abrirLink(\'' + a.link + '\');return false">Abrir página da chave</a></p>' +
                '<div class="ia-linha"><input type="password" id="ia-chave-' + prov + '" placeholder="' + (p.chave_definida ? 'Colar nova chave (opcional)' : 'Colar a chave de API aqui') + '" autocomplete="off" style="flex:1">' +
                (p.chave_definida ? '<button class="ia-btn" onclick="IA.removerChave(\'' + prov + '\')">Remover</button>' : '') + '</div>' +
                '<div class="ia-linha"><label class="ia-mudo">Modelo</label>' + seletorModelo(prov) + '<button class="ia-btn" onclick="IA.carregarModelos(\'' + prov + '\')">Listar modelos</button></div></div>';
        };
        return '<div class="ia-bloco"><p class="ia-mudo">Cada análise usa a <b>sua própria chave de API</b>, guardada só neste computador. O custo é cobrado pelo serviço, por uso (centavos por pergunta). Nada é enviado sem você clicar em Perguntar.</p>' +
            bloco('claude') + bloco('gemini') +
            '<div class="ia-linha"><button class="btn-blue" style="margin:0;width:auto;padding:10px 22px" onclick="IA.salvarConfig()">Salvar</button>' +
            (S.cfg.claude.chave_definida || S.cfg.gemini.chave_definida ? '<button class="ia-btn" onclick="IA.fecharConfig()">Voltar</button>' : '') + '</div>' +
            (S.erro ? '<div class="ia-erro">' + esc(S.erro) + '</div>' : '') + '</div>';
    }
    function seletorModelo(prov) {
        const atual = S.cfg[prov].modelo, lista = (S.modelos && S.modelos[prov]) || [atual];
        const todos = lista.includes(atual) ? lista : [atual].concat(lista);
        return '<select id="ia-modelo-' + prov + '" style="flex:1">' + todos.map(m => '<option value="' + esc(m) + '"' + (m === atual ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select>';
    }

    function telaPrincipal() {
        const c = S.cfg, prov = c.provedor, tem = n => c[n].chave_definida;
        const chips = SUGESTOES.concat(S.sugeridas).map((q, i) => '<button class="ia-chip" onclick="IA.pergunta(' + i + ')">' + esc(q) + '</button>').join('');
        const conversa = S.historico.map(m => m.role === 'user' ? '<div class="ia-msg ia-eu">' + esc(m.content) + '</div>' : '<div class="ia-msg ia-ia">' + md(m.content) + '</div>').join('') +
            (S.carregando ? '<div class="ia-msg ia-ia ia-mudo">Analisando seus números…</div>' : '');
        const ctx = contexto();
        return '<div class="ia-topo"><div class="ia-linha">' +
            (tem('claude') && tem('gemini') ? '<select onchange="IA.trocarProvedor(this.value)"><option value="claude"' + (prov === 'claude' ? ' selected' : '') + '>Claude</option><option value="gemini"' + (prov === 'gemini' ? ' selected' : '') + '>Gemini</option></select>' : '<span class="ia-mudo">' + AJUDA[prov].nome + ' · ' + esc(c[prov].modelo) + '</span>') +
            '<select onchange="IA.opcao(\'qtd\',this.value)"><option value="3"' + (S.qtd === 3 ? ' selected' : '') + '>Últimos 3 meses</option><option value="6"' + (S.qtd === 6 ? ' selected' : '') + '>Últimos 6 meses</option><option value="12"' + (S.qtd === 12 ? ' selected' : '') + '>Últimos 12 meses</option></select>' +
            '<label class="ia-mudo ia-chk"><input type="checkbox" ' + (S.descricoes ? 'checked ' : '') + 'onchange="IA.opcao(\'descricoes\',this.checked)"> Enviar nomes dos lançamentos (iFood, Netflix…)</label>' +
            '<button class="ia-btn" onclick="IA.abrirConfig()">Chaves e modelo</button></div></div>' +
            '<div class="ia-chips">' + chips + '<button class="ia-chip ia-chip-ia" onclick="IA.sugerir()" title="A IA olha seus números e sugere o que vale investigar">✦ Sugerir análises para mim</button></div>' +
            '<div class="ia-conversa" id="ia-conversa">' + (conversa || '<p class="ia-mudo">Escolha uma sugestão acima ou escreva sua pergunta.</p>') + '</div>' +
            (S.erro ? '<div class="ia-erro">' + esc(S.erro) + '</div>' : '') +
            '<div class="ia-entrada"><textarea id="ia-pergunta" rows="2" placeholder="Pergunte algo sobre seus gastos… (Ctrl+Enter envia)" onkeydown="if(event.ctrlKey&&event.key===\'Enter\')IA.enviarDigitada()"></textarea>' +
            '<button class="btn-blue" style="margin:0;width:auto;padding:10px 22px" onclick="IA.enviarDigitada()"' + (S.carregando ? ' disabled' : '') + '>Perguntar</button></div>' +
            '<details class="ia-detalhe"><summary>Ver exatamente o que será enviado à IA (' + ctx.length + ' caracteres)</summary><pre>' + esc(ctx) + '</pre>' +
            '<button class="ia-btn" onclick="IA.copiarParaChat()">Copiar para colar no chat do Claude ou Gemini</button><p class="ia-mudo">Sem chave de API? Copie isto, cole no chat da sua assinatura e faça a pergunta lá.</p></details>' +
            '<p class="ia-mudo" style="margin-top:14px">As respostas da IA podem errar e não substituem um profissional. Confira os números importantes.</p>';
    }

    function desenhar() {
        const area = document.getElementById('ia-corpo');
        if (!area) return;
        if (!S.cfg) { area.innerHTML = '<p class="ia-mudo">Carregando…</p>'; return; }
        const precisa = S.editando || !(S.cfg.claude.chave_definida || S.cfg.gemini.chave_definida);
        area.innerHTML = precisa ? telaConfig() : telaPrincipal();
        const conv = document.getElementById('ia-conversa'); if (conv) conv.scrollTop = conv.scrollHeight;
    }

    async function perguntar(texto) {
        if (S.carregando || !texto.trim()) return;
        S.erro = ''; S.carregando = true;
        const hist = S.historico.slice();
        S.historico.push({ role: 'user', content: texto });
        desenhar();
        const r = await api('/api/ia/perguntar', { pergunta: texto, contexto: contexto(), historico: hist });
        S.carregando = false;
        if (r.ok) S.historico.push({ role: 'assistant', content: r.resposta }); else { S.erro = r.mensagem || 'Não foi possível responder.'; S.historico.pop(); }
        desenhar();
        return r;
    }

    const IA = {
        async renderizar(area) {
            area.innerHTML = '<div id="ia-corpo"></div>';
            if (!S.cfg) S.cfg = await api('/api/ia/config');
            desenhar();
        },
        pergunta(i) { perguntar(SUGESTOES.concat(S.sugeridas)[i]); },
        enviarDigitada() { const t = document.getElementById('ia-pergunta'); if (t && t.value.trim()) { const v = t.value; t.value = ''; perguntar(v); } },
        async sugerir() {
            if (S.carregando) return;
            S.carregando = true; S.erro = ''; desenhar();
            const r = await api('/api/ia/perguntar', { pergunta: 'Olhando meus números, sugira 5 perguntas curtas e úteis que eu deveria fazer sobre minhas finanças. Responda SOMENTE com uma lista JSON de 5 strings, sem texto extra.', contexto: contexto(), historico: [] });
            S.carregando = false;
            if (r.ok) {
                try { const m = r.resposta.match(/\[[\s\S]*\]/); const l = JSON.parse(m ? m[0] : r.resposta); S.sugeridas = l.filter(x => typeof x === 'string').slice(0, 5); } catch (e) { S.erro = 'A IA respondeu de um jeito inesperado. Tente de novo.'; }
            } else S.erro = r.mensagem;
            desenhar();
        },
        opcao(k, v) { S[k] = k === 'qtd' ? parseInt(v, 10) : !!v; desenhar(); },
        trocarProvedor(p) { S.cfg.provedor = p; api('/api/ia/config', { provedor: p }); desenhar(); },
        abrirConfig() { S.editando = true; S.erro = ''; desenhar(); },
        fecharConfig() { S.editando = false; S.erro = ''; desenhar(); },
        async salvarConfig() {
            const g = id => (document.getElementById(id) || {}).value || '';
            const nc = g('ia-chave-claude'), ng = g('ia-chave-gemini');
            const temC = S.cfg.claude.chave_definida || nc, temG = S.cfg.gemini.chave_definida || ng;
            let prov = S.cfg.provedor;
            if (prov === 'claude' && !temC && temG) prov = 'gemini';
            if (prov === 'gemini' && !temG && temC) prov = 'claude';
            const r = await api('/api/ia/config', { chave_claude: nc, chave_gemini: ng, modelo_claude: g('ia-modelo-claude'), modelo_gemini: g('ia-modelo-gemini'), provedor: prov });
            if (r.ok === false) { S.erro = r.mensagem; desenhar(); return; }
            S.cfg = r; S.erro = ''; S.editando = false; desenhar();
        },
        async removerChave(prov) {
            if (!window.confirm('Remover a chave do ' + AJUDA[prov].nome + ' deste computador?')) return;
            const corpo = {}; corpo['remover_' + prov] = true;
            const r = await api('/api/ia/config', corpo); S.cfg = r; desenhar();
        },
        async carregarModelos(prov) {
            const chave = (document.getElementById('ia-chave-' + prov) || {}).value;
            if (chave && chave.trim()) { const corpo = {}; corpo['chave_' + prov] = chave; const s = await api('/api/ia/config', corpo); if (s.ok === false) { S.erro = s.mensagem; desenhar(); return; } S.cfg = s; }
            const r = await api('/api/ia/modelos?provedor=' + prov);
            if (!r.ok) { S.erro = r.mensagem; desenhar(); return; }
            S.erro = ''; S.modelos = S.modelos || {}; S.modelos[prov] = r.modelos; desenhar();
        },
        copiarParaChat() {
            const texto = 'Você é um analista de finanças pessoais. Use só os dados abaixo, responda em português, com sugestões práticas.\n\n=== DADOS ===\n' + contexto() + '\n\n=== MINHA PERGUNTA ===\n';
            const ok = () => window.mostrarAviso && window.mostrarAviso('Copiado. Cole no chat e escreva sua pergunta no fim.', 'sucesso');
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(texto).then(ok, () => window.prompt('Copie:', texto)); else window.prompt('Copie:', texto);
        },
        abrirLink(url) { api('/api/ia/abrir_link', { url }); },
    };
    global.IA = IA;
})(typeof globalThis !== 'undefined' ? globalThis : this);
