/* Aparência (Configurações): combinação de cores, cor de destaque e tamanho. Salvo no servidor (aparencia.json). */
const Aparencia = (() => {
    // [chave, nome, escuro?, fundo, superfície, texto]  (só para a prévia; as cores reais ficam no style.css)
    const PALETAS = [
        ['concreto', 'Concreto', 1, '#181311', '#211B18', '#EFE6D8'],
        ['gofre', 'Gofre violeta', 1, '#14102B', '#1F1A3F', '#F1EEFF'],
        ['grafite', 'Grafite', 1, '#101215', '#1d2127', '#e8eaed'],
        ['meianoite', 'Meia-noite', 1, '#0b1220', '#18233a', '#e6ebf5'],
        ['floresta', 'Floresta', 1, '#0f1512', '#1b2520', '#e5ece7'],
        ['vinho', 'Vinho', 1, '#16100f', '#271c1b', '#efe6e4'],
        ['ardosia', 'Ardósia', 1, '#14161a', '#22262d', '#e9ebef'],
        ['preto', 'Preto total', 1, '#000000', '#131315', '#ececee'],
        ['claro', 'Claro', 0, '#f1f2f4', '#ffffff', '#1c2127'],
        ['areia', 'Areia', 0, '#f3efe7', '#fffdf9', '#2a2620'],
        ['mar', 'Mar', 0, '#eef3f7', '#ffffff', '#17232e'],
        ['menta', 'Menta', 0, '#eef5f0', '#ffffff', '#18261d'],
    ];
    const CORES = [['bordo', 'Bordô'], ['gold', 'Latão'], ['orange', 'Laranja'], ['coral', 'Coral'], ['rose', 'Rosa'], ['violet', 'Violeta'],
                   ['steel', 'Azul-aço'], ['teal', 'Turquesa'], ['moss', 'Verde-musgo'], ['lime', 'Lima']];
    // [chave, nome, positivo, negativo, atenção]  (a combinação "paleta" usa as cores da própria combinação)
    const STATUS = [['paleta', 'Da combinação'], ['suave', 'Suave', '#8fb39a', '#cf8173', '#cfae6e'], ['classico', 'Clássico', '#4fbf8a', '#e0675a', '#e3b341'],
                    ['azul', 'Azul e âmbar', '#7fb0e0', '#e0a15a', '#d9c46a'], ['cremebordo', 'Creme e bordô', '#e6dcc6', '#d9707f', '#c9bd9f']];
    const TAMANHOS = [['compacta', 'Compacto'], ['normal', 'Normal'], ['confortavel', 'Amplo']];

    function atual() {
        const r = document.documentElement.dataset;
        return { paleta: r.paleta || 'concreto', destaque: r.accent || 'bordo', densidade: r.densidade || 'normal', cor: corPersonalizada(),
                 status: r.status || 'paleta', s_ok: lerVar('--s-ok', '#8fb39a'), s_ruim: lerVar('--s-ruim', '#cf8173'), s_atencao: lerVar('--s-atencao', '#cfae6e') };
    }
    function lerVar(nome, padrao) {
        return (getComputedStyle(document.documentElement).getPropertyValue(nome) || padrao).trim() || padrao;
    }
    function corPersonalizada() {
        return (getComputedStyle(document.documentElement).getPropertyValue('--a-custom') || '#8c6bff').trim() || '#8c6bff';
    }
    function textoSobre(hex) {
        const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
        return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#14102B' : '#FFFFFF';
    }
    function aplicar(p) {
        const r = document.documentElement;
        const clara = (PALETAS.find(x => x[0] === p.paleta) || [])[2] === 0;
        r.dataset.theme = clara ? 'light' : 'dark';
        r.dataset.paleta = p.paleta;
        r.dataset.accent = p.destaque;
        r.dataset.densidade = p.densidade;
        r.dataset.status = p.status || 'paleta';
        if (p.s_ok) r.style.setProperty('--s-ok', p.s_ok);
        if (p.s_ruim) r.style.setProperty('--s-ruim', p.s_ruim);
        if (p.s_atencao) r.style.setProperty('--s-atencao', p.s_atencao);
        if (p.cor) r.style.setProperty('--a-custom', p.cor);
        if (p.destaque === 'custom' && p.cor) r.style.setProperty('--on-accent', textoSobre(p.cor));
        else r.style.removeProperty('--on-accent');
    }
    function escolher(chave, valor, extra) {
        const p = Object.assign(atual(), { [chave]: valor }, extra || {});
        aplicar(p);
        desenhar();
        fetch('/api/aparencia', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).catch(() => {});
    }
    function corLivre(hex) {                       // enquanto arrasta na roda: só mostra
        aplicar(Object.assign(atual(), { destaque: 'custom', cor: hex }));
    }
    function corFinal(hex) {                       // ao soltar: guarda
        escolher('destaque', 'custom', { cor: hex });
    }
    function statusLivre(chave, hex) {             // arrastando uma das 3 cores de situação
        aplicar(Object.assign(atual(), { status: 'custom', [chave]: hex }));
        const el = document.getElementById('apStatusPrev'); if (el) el.dataset.on = '1';
    }
    function statusFinal(chave, hex) { escolher('status', 'custom', { [chave]: hex }); }
    function restaurar() {
        escolher('paleta', 'concreto', { destaque: 'bordo', densidade: 'normal', status: 'paleta' });
    }
    function desenhar() {
        const c = document.getElementById('conteudoAparencia');
        if (!c) return;
        const p = atual();
        const grupo = (titulo, escuras) => `<div class="ap-rotulo">${titulo}</div><div class="ap-paletas">` +
            PALETAS.filter(x => !!x[2] === escuras).map(([k, nome, , bg, sf, tx]) =>
                `<button type="button" class="ap-paleta ${k === p.paleta ? 'on' : ''}" onclick="Aparencia.escolher('paleta','${k}')">` +
                `<div class="ap-amostra"><i style="background:${bg}"></i><i style="background:${sf}"></i><i style="background:${tx}"></i><i style="background:var(--a-${p.destaque})"></i></div>${nome}</button>`).join('') + '</div>';
        c.innerHTML = grupo('Combinações escuras', true) + grupo('Combinações claras', false) +
            '<div class="ap-rotulo">Cor de destaque</div><div class="ap-cores">' +
            CORES.map(([v, t]) => `<button type="button" class="ap-cor ${v === p.destaque ? 'on' : ''}" style="--c:var(--a-${v})" title="${t}" aria-label="${t}" onclick="Aparencia.escolher('destaque','${v}')"></button>`).join('') +
            '<label class="ap-roda ' + (p.destaque === 'custom' ? 'on' : '') + '" title="Cor personalizada (roda de cores)"><input type="color" value="' + p.cor + '" aria-label="Escolher cor personalizada" oninput="Aparencia.corLivre(this.value)" onchange="Aparencia.corFinal(this.value)"></label>' +
            '</div><div class="ap-rotulo">Cores de situação (pago, pendente, saldo positivo ou negativo, orçamento estourado)</div><div class="ap-paletas">' +
            STATUS.map(([k, nome, a, b, c]) => `<button type="button" class="ap-paleta ${k === p.status ? 'on' : ''}" onclick="Aparencia.escolher('status','${k}')">` +
                `<div class="ap-amostra">${k === 'paleta' ? '<i style="background:var(--surface-3)"></i><i style="background:var(--text-muted)"></i><i style="background:var(--text-main)"></i>' : `<i style="background:${a}"></i><i style="background:${b}"></i><i style="background:${c}"></i>`}</div>${nome}</button>`).join('') + '</div>' +
            '<div class="ap-status-custom ' + (p.status === 'custom' ? 'on' : '') + '">' +
            [['s_ok', 'Positivo'], ['s_ruim', 'Negativo'], ['s_atencao', 'Atenção']].map(([k, t]) =>
                `<label>${t}<input type="color" value="${p[k]}" aria-label="${t}" oninput="Aparencia.statusLivre('${k}',this.value)" onchange="Aparencia.statusFinal('${k}',this.value)"></label>`).join('') +
            '</div><div class="ap-rotulo">Tamanho da tela</div><div class="ap-seg">' +
            TAMANHOS.map(([v, t]) => `<button type="button" class="${v === p.densidade ? 'on' : ''}" onclick="Aparencia.escolher('densidade','${v}')">${t}</button>`).join('') + '</div>' +
            '<div style="margin-top:22px"><button type="button" class="ap-restaurar" onclick="Aparencia.restaurar()">Restaurar visual padrão do Gofre</button></div>';
    }
    function abrir() {
        document.getElementById('view-configs').classList.add('hidden');
        document.getElementById('view-config-aparencia').classList.remove('hidden');
        desenhar();
    }
    function voltar() {
        document.getElementById('view-config-aparencia').classList.add('hidden');
        document.getElementById('view-configs').classList.remove('hidden');
    }
    return { abrir, voltar, escolher, atual, corLivre, corFinal, statusLivre, statusFinal, restaurar };
})();
function abrirAparencia() { Aparencia.abrir(); }

// Aviso de versão nova (só aparece se o projeto estiver ligado a um repositório do GitHub)
(function () {
    fetch('/api/atualizacao').then(r => r.json()).then(d => {
        const el = document.getElementById('avisoAtualizacao');
        if (!el || !d || !d.disponivel) return;
        el.classList.remove('hidden');
        el.innerHTML = '<button type="button" class="ap-restaurar" id="btnNovaVersao">Nova versão ' + d.nova + ' disponível — ver</button>';
        document.getElementById('btnNovaVersao').onclick = () => fetch('/api/abrir_pagina_projeto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: d.url }) });
    }).catch(() => {});
})();
