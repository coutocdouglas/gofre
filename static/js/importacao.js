// ============================================================
// IMPORTAR FATURA (PDF) — Fase 3
// O PDF é só LIDO. Nada é gravado até você revisar e clicar em "Importar".
// Tudo que entra pode ser desfeito de uma vez com Ctrl+Z.
// ============================================================
(function (global) {
    'use strict';

    // ---------- Funções puras (testadas no Node) ----------
    function normalizar(t) {
        return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function arred2(n) { return Math.round((Number(n) + (n < 0 ? -1e-9 : 1e-9)) * 100) / 100; }

    // Divide um valor entre pessoas por porcentagem, em centavos, sem sobrar nem faltar nada.
    function dividirValor(valor, pcts) {
        const centavos = Math.round(Number(valor) * 100);
        const lista = (pcts || []).filter(function (p) { return Number(p.pct) > 0; });
        if (!lista.length) return [];
        const somaP = lista.reduce(function (s, p) { return s + Number(p.pct); }, 0);
        let usado = 0;
        return lista.map(function (p, i) {
            let c;
            if (i === lista.length - 1) c = centavos - usado;
            else { c = Math.round(centavos * Number(p.pct) / somaP); usado += c; }
            return { pessoa_id: p.pessoa_id, valor: c / 100 };
        });
    }

    // Divide igualmente entre as pessoas (os centavos que sobram vão para as primeiras).
    function dividirIgual(valor, ids) {
        const n = ids.length;
        if (!n) return [];
        const c = Math.round(Number(valor) * 100);
        const base = Math.trunc(c / n);
        let resto = c - base * n;
        const passo = resto < 0 ? -1 : 1;
        return ids.map(function (id) {
            let v = base;
            if (resto !== 0) { v += passo; resto -= passo; }
            return { pessoa_id: id, valor: v / 100 };
        });
    }

    function somaDiv(div) {
        return Math.round((div || []).reduce(function (s, d) { return s + Math.round((Number(d.valor) || 0) * 100); }, 0)) / 100;
    }

    // Diferença entre o valor da linha e o que foi distribuído (0 = certinho).
    function faltaDiv(valor, div) {
        return Math.round(Math.round(Number(valor) * 100) - Math.round(somaDiv(div) * 100)) / 100;
    }

    // Converte reais em porcentagem (usado para salvar regras, que valem para qualquer valor).
    function pctsDe(div, valor) {
        const total = Number(valor);
        if (!total) return [];
        return (div || []).filter(function (d) { return Number(d.valor) !== 0; }).map(function (d) {
            return { pessoa_id: d.pessoa_id, pct: Math.round(Number(d.valor) / total * 10000) / 100 };
        });
    }

    function pendente(l) {
        return !l.nome.trim() || !(l.div || []).length || Math.abs(faltaDiv(l.valor, l.div)) > 0.005;
    }

    function resumo(linhas) {
        const r = { importar: 0, total: 0, ignoradas: 0, pendentes: 0, validadas: 0, naoValidadas: 0 };
        linhas.forEach(function (l) {
            if (!l.incluir) { r.ignoradas++; return; }
            r.importar++; r.total += Number(l.valor);
            if (pendente(l)) r.pendentes++;
            if (l.validada) r.validadas++; else r.naoValidadas++;
        });
        r.total = arred2(r.total);
        return r;
    }

    function chaveCartaoPadrao(secao, emissor, cartoes) {
        const alvoFinal = String(secao.final || '');
        let achados = alvoFinal ? cartoes.filter(function (c) { return normalizar(c.nome).indexOf(alvoFinal) >= 0; }) : [];
        if (achados.length === 1) return achados[0].id;
        achados = cartoes.filter(function (c) { return normalizar(c.nome).indexOf(emissor) >= 0; });
        return achados.length === 1 ? achados[0].id : '';
    }

    function montarLinhas(fatura, sugestoes) {
        const porSeq = {};
        sugestoes.forEach(function (s) { porSeq[s.seq] = s; });
        const out = [];
        fatura.secoes.forEach(function (sec, idx) {
            sec.linhas.forEach(function (ln) {
                const s = porSeq[ln.seq];
                if (!s) return;
                out.push({
                    seq: ln.seq, secao: idx, data: ln.data, original: ln.descricao_original, descricao: ln.descricao,
                    valor: ln.valor, valorUsd: ln.valor_usd, tipo: ln.tipo, parcelaPdf: !!ln.parcela_atual,
                    incluir: s.acao === 'lancar', motivo: s.motivo, nivel: s.nivel, existente: s.existente,
                    avisos: s.avisos || [], nome: s.nome || '', cat_id: s.cat_id || '', subcat_id: s.subcat_id || '',
                    atual: ln.parcela_atual || 1, total: ln.total_parcelas || 1, modo: s.modo,
                    div: dividirValor(ln.valor, s.divisao_pct || []),
                    regra_id: s.regra_id || null, lembrar: false, tocada: false, fixo: !!s.fixo,
                    validada: false, vinculo: null, compra_pai: null, absorvida: false
                });
            });
        });
        return out;
    }

    function montarPayload(estado) {
        const itens = [], regras = {};
        estado.linhas.forEach(function (l) {
            if (!l.incluir) return;
            const cartao = estado.mapeamento[l.secao];
            const total = Math.max(1, parseInt(l.total, 10) || 1);
            const atual = Math.min(total, Math.max(1, parseInt(l.atual, 10) || 1));
            itens.push({
                desc: l.nome.trim(), cartao_id: cartao, data: l.data, valor: l.valor,
                parcela_atual: atual, total_parcelas: total, modo: total > 1 && atual < total ? l.modo : 'so_esta',
                cat_id: l.cat_id || null, subcat_id: l.subcat_id || null,
                divisao: (l.div || []).filter(function (d) { return Number(d.valor) !== 0; })
                    .map(function (d) { return { pessoa_id: d.pessoa_id, valor: Math.round(Number(d.valor) * 100) / 100 }; }),
                regra_id: l.regra_id || null, compra_pai: l.compra_pai || null, fixo: !!l.fixo
            });
            if (l.lembrar) {
                const padrao = normalizar(l.descricao);
                regras[padrao] = { padrao: padrao, nome: l.nome.trim(), cat_id: l.cat_id || null,
                                   subcat_id: l.subcat_id || null, divisao: pctsDe(l.div, l.valor), fixo: !!l.fixo };
            }
        });
        return {
            mes_fatura: estado.mes, itens: itens,
            regras: Object.keys(regras).map(function (k) { return regras[k]; }),
            arquivo: { hash: estado.arquivo.hash, nome: estado.arquivo.nome,
                       emissor: estado.fatura.emissor, vencimento: estado.fatura.vencimento,
                       total: estado.fatura.total_fatura }
        };
    }

    // Copia a classificação para outras linhas com a mesma descrição (que ainda não foram mexidas nem validadas).
    // A divisão é copiada em proporção (o valor de cada linha pode ser diferente).
    function propagar(linhas, origem, campos) {
        const chave = normalizar(origem.descricao);
        linhas.forEach(function (l) {
            if (l === origem || l.tocada || l.validada || normalizar(l.descricao) !== chave) return;
            campos.forEach(function (c) {
                if (c === 'div') l.div = dividirValor(l.valor, pctsDe(origem.div, origem.valor));
                else l[c] = origem[c];
            });
        });
    }

    function mesesEntre(a, b) { return (parseInt(a.slice(0, 4), 10) - parseInt(b.slice(0, 4), 10)) * 12 + parseInt(a.slice(5, 7), 10) - parseInt(b.slice(5, 7), 10); }

    // Lançamentos já feitos que podem ser a "mesma compra" desta linha (um por compra), melhores primeiro.
    function candidatosVinculo(faturas, linha, opc) {
        const busca = normalizar(opc.busca || '');
        const grupos = {};
        faturas.forEach(function (f) {
            if (!opc.todosCartoes && f.cartao_id !== opc.cartaoId) return;
            const g = f.id_compra_pai || f.id;
            const d = mesesEntre(f.mes_fatura, opc.mes);
            const atual = grupos[g];
            const melhor = !atual || Math.abs(d) < Math.abs(atual.d) || (Math.abs(d) === Math.abs(atual.d) && d < atual.d);
            if (melhor) grupos[g] = { f: f, d: d };
        });
        const palavras = normalizar(linha.descricao).split(' ').filter(function (p) { return p.length >= 4; });
        const lista = [];
        Object.keys(grupos).forEach(function (g) {
            const f = grupos[g].f, d = grupos[g].d;
            const nome = normalizar(f.desc);
            if (busca) { if (nome.indexOf(busca) < 0) return; }
            else if (d < -12 || d > 2) return;
            let score = 0;
            if (Math.abs(Number(f.valor_parcela) - Number(linha.valor)) < 0.011) score += 3;
            if (linha.total > 1 && f.total_parcelas === linha.total) score += 2;
            if (palavras.some(function (p) { return nome.indexOf(p) >= 0; })) score += 1.5;
            score -= Math.abs(d) * 0.1;
            lista.push({ f: f, score: score });
        });
        lista.sort(function (a, b) { return b.score - a.score || (a.f.mes_fatura < b.f.mes_fatura ? 1 : -1); });
        return lista.slice(0, 80).map(function (x) { return x.f; });
    }

    // Copia nome, categoria, subcategoria, parcela e responsáveis do lançamento escolhido.
    function aplicarVinculo(l, ex, mes, faturas) {
        l.vinculo = { id: ex.id, desc: ex.desc, mes_fatura: ex.mes_fatura, parcela_atual: ex.parcela_atual, total_parcelas: ex.total_parcelas };
        l.compra_pai = ex.id_compra_pai || null;
        l.nome = ex.desc; l.cat_id = ex.cat_id || ''; l.subcat_id = ex.subcat_id || '';
        l.regra_id = null; l.tocada = true; l.fixo = !!ex.fixo;
        if (!l.parcelaPdf) {
            l.total = ex.total_parcelas || 1;
            l.atual = Math.min(l.total, Math.max(1, (ex.parcela_atual || 1) + mesesEntre(mes, ex.mes_fatura)));
        }
        const pcts = pctsDe((ex.divisao || []).map(function (d) { return { pessoa_id: d.pessoa_id, valor: d.valor }; }), ex.valor_parcela);
        if (pcts.length) l.div = dividirValor(l.valor, pcts);
        // O lançamento que já existe SEMPRE vence (já tem a classificação certa):
        // se ele (ou outra parcela da mesma compra) já cobre esta parcela, em qualquer mês, esta linha é absorvida.
        const mesmaCompra = faturas.filter(function (f) { return (f.id_compra_pai || f.id) === (ex.id_compra_pai || ex.id); });
        const cobre = mesmaCompra.filter(function (f) { return f.parcela_atual === l.atual; });
        const unica = l.total <= 1 && (ex.total_parcelas || 1) <= 1;
        const jaTem = cobre.length > 0 || unica;
        l.absorvida = jaTem;
        l.modo = l.total > 1 && l.atual < l.total ? 'esta_e_seguintes' : 'so_esta';   // o servidor só cria as parcelas que faltam
        if (jaTem) {
            const manter = cobre[0] || ex;
            l.incluir = false; l.motivo = 'vinculada_existente';
            l.existente = { desc: manter.desc, mes_fatura: manter.mes_fatura, parcela_atual: manter.parcela_atual, total_parcelas: manter.total_parcelas };
        } else { l.incluir = true; l.motivo = 'vinculada'; }
        return { jaLancada: jaTem };
    }

    const puras = { normalizar: normalizar, dividirValor: dividirValor, dividirIgual: dividirIgual, somaDiv: somaDiv,
                    faltaDiv: faltaDiv, pctsDe: pctsDe, resumo: resumo, chaveCartaoPadrao: chaveCartaoPadrao,
                    montarLinhas: montarLinhas, montarPayload: montarPayload, propagar: propagar,
                    candidatosVinculo: candidatosVinculo, aplicarVinculo: aplicarVinculo, mesesEntre: mesesEntre };
    global.ImportacaoPuras = puras;
    if (typeof document === 'undefined') return;   // testes no Node: só as funções puras

    // ---------- Tela ----------
    let E = null;      // estado da importação em andamento
    let raiz = null;

    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function moeda(v) { return (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    function dataBR(iso) { return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(2, 4) : ''; }
    function mesBR(m) {
        const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
        return m ? nomes[parseInt(m.slice(5, 7), 10) - 1] + '/' + m.slice(0, 4) : '';
    }
    function aviso(t, tipo) { if (global.mostrarAviso) global.mostrarAviso(t, tipo); }

    function pessoas() { return global.db_pessoas || (typeof db_pessoas !== 'undefined' ? db_pessoas : []); }
    function cartoes() { return typeof db_cartoes !== 'undefined' ? db_cartoes : []; }
    function categorias() { return typeof db_categorias !== 'undefined' ? db_categorias : []; }

    async function api(url, opcoes) {
        const r = await fetch(url, opcoes);
        return r.json();
    }

    // ----- Janela flutuante (arrastar pelo topo, redimensionar pelo canto, ampliar/reduzir) -----
    let geom = null, ampliada = false, arrasto = null;
    function geomPadrao() {
        const w = Math.min(1080, Math.round(global.innerWidth * 0.8)), h = Math.round(global.innerHeight * 0.84);
        return { w: w, h: h, x: Math.round((global.innerWidth - w) / 2), y: Math.round((global.innerHeight - h) / 2) };
    }
    function posicionarJanela() {
        const j = raiz && raiz.querySelector('.imp-janela');
        if (!j) return;
        if (!geom) geom = geomPadrao();
        j.classList.toggle('imp-max', ampliada);
        if (ampliada) { j.style.cssText = ''; return; }
        const w = Math.min(geom.w, global.innerWidth - 8), h = Math.min(geom.h, global.innerHeight - 8);
        const x = Math.max(0, Math.min(geom.x, global.innerWidth - Math.min(w, 120))), y = Math.max(0, Math.min(geom.y, global.innerHeight - 60));
        j.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;';
    }
    function guardarGeom() {
        const j = raiz && raiz.querySelector('.imp-janela');
        if (!j || ampliada) return;
        geom = { w: j.offsetWidth, h: j.offsetHeight, x: j.offsetLeft, y: j.offsetTop };
    }
    function iniciarArrasto(ev) {
        if (ampliada || ev.button !== 0 || ev.target.closest('button')) return;
        const topo = ev.target.closest('.imp-topo');
        const j = topo && topo.closest('.imp-janela');
        if (!j || topo.closest('.imp-gaveta')) return;
        arrasto = { dx: ev.clientX - j.offsetLeft, dy: ev.clientY - j.offsetTop, j: j };
        ev.preventDefault();
    }
    document.addEventListener('mousemove', function (ev) {
        if (!arrasto) return;
        const x = Math.max(-arrasto.j.offsetWidth + 120, Math.min(ev.clientX - arrasto.dx, global.innerWidth - 120));
        const y = Math.max(0, Math.min(ev.clientY - arrasto.dy, global.innerHeight - 50));
        arrasto.j.style.left = x + 'px'; arrasto.j.style.top = y + 'px';
    });
    document.addEventListener('mouseup', function () { if (raiz && raiz.classList.contains('active')) guardarGeom(); arrasto = null; });
    global.addEventListener('resize', function () { if (raiz && raiz.classList.contains('active')) posicionarJanela(); });

    function abrir() {
        if (!raiz) {
            raiz = document.createElement('div');
            raiz.className = 'imp-overlay';
            raiz.addEventListener('click', aoClicar);
            raiz.addEventListener('mousedown', iniciarArrasto);
            raiz.addEventListener('change', aoMudar);
            raiz.addEventListener('input', aoDigitar);
            document.body.appendChild(raiz);
        }
        E = { passo: 1, arquivoObj: null, precisaSenha: false, erro: '', carregando: false, filtro: 'todas',
              mapeamento: {}, linhas: [], lembrarTodos: false, busca: '', buscaVinculo: '', vinculando: null, vincTodos: false, mes: '', fatura: null, arquivo: null, anterior: null };
        raiz.classList.add('active');
        desenhar();
    }

    function fechar(perguntar) {
        if (perguntar && E && E.passo === 3 && !global.confirm('Sair sem importar? O que você revisou será perdido.')) return;
        raiz.classList.remove('active');
        E = null;
    }

    function desenhar() {
        const titulos = ['', '1. Escolha o PDF', '2. Cartões e mês', '3. Revise e importe'];
        raiz.innerHTML =
            '<div class="imp-janela">' +
            '<div class="imp-topo"><div><h2><svg class="ic ic-t"><use href="#i-file"/></svg>Importar fatura</h2><span class="imp-passo">' + titulos[E.passo] + '</span></div>' +
            '<div class="imp-botoes-topo"><button class="imp-x" data-acao="maximizar" title="Ampliar / reduzir"><svg class="ic"><use href="#i-expandir"/></svg></button>' +
            '<button class="imp-x" data-acao="fechar" title="Fechar"><svg class="ic"><use href="#i-x"/></svg></button></div></div>' +
            '<div class="imp-corpo" id="imp-corpo"></div></div>';
        posicionarJanela();
        if (E.passo === 1) corpoPasso1();
        else if (E.passo === 2) corpoPasso2();
        else corpoPasso3();
    }
    const corpo = function () { return document.getElementById('imp-corpo'); };

    // ----- Passo 1 -----
    function corpoPasso1() {
        corpo().innerHTML =
            '<p class="imp-ajuda">Escolha o PDF da fatura (<b>XP</b> ou <b>Inter</b>). O arquivo é apenas lido — ' +
            'ele <b>não é guardado</b> no programa.</p>' +
            '<label class="imp-arquivo"><input type="file" id="imp-arq" accept="application/pdf,.pdf">' +
            '<span>' + (E.arquivoObj ? '<svg class="ic ic-t"><use href="#i-clip"/></svg>' + esc(E.arquivoObj.name) : 'Clique para escolher o arquivo…') + '</span></label>' +
            (E.precisaSenha ? '<div class="imp-senha"><label>Senha do PDF</label>' +
                '<input type="password" id="imp-senha" autocomplete="off" placeholder="Digite a senha"></div>' : '') +
            (E.erro ? '<div class="imp-erro">' + esc(E.erro) + '</div>' : '') +
            '<div class="imp-rodape"><button class="imp-btn" data-acao="fechar">Cancelar</button>' +
            '<button class="imp-btn imp-primario" data-acao="ler"' + (E.carregando ? ' disabled' : '') + '>' +
            (E.carregando ? 'Lendo…' : 'Ler fatura') + '</button></div>';
    }

    async function lerPdf() {
        if (!E.arquivoObj) { E.erro = 'Escolha um arquivo primeiro.'; return corpoPasso1(); }
        const campo = document.getElementById('imp-senha');
        const fd = new FormData();
        fd.append('arquivo', E.arquivoObj);
        if (campo && campo.value) fd.append('senha', campo.value);
        E.carregando = true; E.erro = ''; corpoPasso1();
        let r;
        try { r = await api('/api/importacao/ler', { method: 'POST', body: fd }); }
        catch (e) { r = { ok: false, erro: 'rede', mensagem: 'Não consegui falar com o programa. Tente de novo.' }; }
        E.carregando = false;
        if (!r.ok) {
            E.precisaSenha = r.erro === 'senha_necessaria' || r.erro === 'senha_incorreta';
            E.erro = r.mensagem || 'Não foi possível ler este PDF.';
            return corpoPasso1();
        }
        E.fatura = r.fatura; E.arquivo = r.arquivo; E.anterior = r.importacao_anterior; E.mes = r.fatura.mes_fatura;
        E.mapeamento = {};
        r.fatura.secoes.forEach(function (s, i) { E.mapeamento[i] = chaveCartaoPadrao(s, r.fatura.emissor, cartoes()); });
        E.passo = 2; desenhar();
    }

    // ----- Passo 2 -----
    function corpoPasso2() {
        const f = E.fatura;
        const conf = f.conferencia || {};
        const opcoes = function (sel) {
            return '<option value="">— escolha o cartão —</option>' + cartoes().map(function (c) {
                return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.nome) + '</option>';
            }).join('');
        };
        const linhasSecao = f.secoes.map(function (s, i) {
            return '<div class="imp-sec"><div><b>' + esc(s.rotulo) + '</b><span class="imp-mudo"> · ' +
                s.linhas.length + ' linhas · ' + moeda(s.subtotal) + '</span></div>' +
                '<select data-campo="cartao" data-secao="' + i + '">' + opcoes(E.mapeamento[i]) + '</select></div>';
        }).join('');
        corpo().innerHTML =
            '<div class="imp-resumo-pdf"><div><span class="imp-mudo">Fatura</span><b>' + esc(f.emissor_rotulo) + '</b></div>' +
            '<div><span class="imp-mudo">Vencimento</span><b>' + dataBR(f.vencimento) + '</b></div>' +
            '<div><span class="imp-mudo">Total do PDF</span><b>' + moeda(f.total_fatura) + '</b></div>' +
            '<div><span class="imp-mudo">Conferência</span><b class="' + (conf.ok ? 'imp-ok' : 'imp-alerta') + '">' +
            (conf.ok ? '<svg class="ic ic-t"><use href="#i-check"/></svg>soma bate com o PDF' : '<svg class="ic ic-t"><use href="#i-alert"/></svg>diferença de ' + moeda(conf.diferenca)) + '</b></div></div>' +
            (E.anterior ? '<div class="imp-alerta-caixa"><svg class="ic ic-t"><use href="#i-alert"/></svg>' + (E.anterior.mesmo_arquivo ? 'Este mesmo PDF' : 'Uma fatura igual a esta') +
                ' já foi importada em ' + esc(E.anterior.criado_em.replace('T', ' ')) + ' (' + E.anterior.ainda_existem +
                ' lançamentos ainda existem). Importar de novo pode duplicar tudo.</div>' : '') +
            '<h3>A qual cartão do sistema pertence cada parte?</h3>' + linhasSecao +
            '<h3>Em qual mês esta fatura entra?</h3>' +
            '<div class="imp-sec"><div class="imp-mudo">É o mês do vencimento, como no resto do sistema.</div>' +
            '<input type="month" data-campo="mes" value="' + esc(E.mes) + '"></div>' +
            (E.erro ? '<div class="imp-erro">' + esc(E.erro) + '</div>' : '') +
            '<div class="imp-rodape"><button class="imp-btn" data-acao="voltar1">Voltar</button>' +
            '<button class="imp-btn imp-primario" data-acao="analisar"' + (E.carregando ? ' disabled' : '') + '>' +
            (E.carregando ? 'Analisando…' : 'Continuar') + '</button></div>';
    }

    async function analisar() {
        const faltam = E.fatura.secoes.some(function (s, i) { return !E.mapeamento[i]; });
        if (faltam) { E.erro = 'Escolha o cartão de cada parte da fatura.'; return corpoPasso2(); }
        if (!/^\d{4}-\d{2}$/.test(E.mes)) { E.erro = 'Escolha o mês da fatura.'; return corpoPasso2(); }
        E.carregando = true; E.erro = ''; corpoPasso2();
        const r = await api('/api/importacao/sugerir', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fatura: E.fatura, mapeamento: E.mapeamento, mes_fatura: E.mes })
        });
        E.carregando = false;
        if (!r.ok) { E.erro = r.mensagem || 'Não foi possível analisar.'; return corpoPasso2(); }
        E.linhas = montarLinhas(E.fatura, r.sugestoes, pessoas());
        E.passo = 3; desenhar();
    }

    // ----- Passo 3 -----
    const ROTULO_MOTIVO = { ja_lancada: ['Já lançada', 'imp-b-ok'], provavel: ['Provável duplicada', 'imp-b-av'],
                            pagamento: ['Pagamento', 'imp-b-mudo'], vinculada: ['Vinculada', 'imp-b-ok'],
                            vinculada_existente: ['Já existe (vinculada)', 'imp-b-ok'] };
    const ROTULO_AVISO = { encargo: 'Encargo', estorno: 'Estorno', exterior: 'Exterior (USD)',
                           parcela_sem_historico: 'Parcela sem histórico' };

    function nomePessoa(id) {
        const p = pessoas().find(function (x) { return x.id === id; });
        return p ? p.nome : '?';
    }
    function nomeCategoria(l) {
        const c = categorias().find(function (x) { return x.id === l.cat_id; });
        if (!c) return 'Sem categoria';
        const sub = (c.subcategorias || []).find(function (x) { return x.id === l.subcat_id; });
        return c.nome + (sub ? ' › ' + sub.nome : '');
    }

    function corpoPasso3() {
        corpo().innerHTML =
            '<div class="imp-barra">' +
            '<div class="imp-filtros">' + [['todas', 'Todas'], ['importar', 'A importar'], ['naoval', 'Não validadas'], ['validadas', 'Validadas'],
                ['ignoradas', 'Ignoradas'], ['pendentes', 'Com pendência']]
                .map(function (f) { return '<button class="imp-chip' + (E.filtro === f[0] ? ' ativo' : '') + '" data-acao="filtro" data-v="' + f[0] + '">' + f[1] + '</button>'; }).join('') + '</div>' +
            '<input type="search" id="imp-busca" class="imp-busca" placeholder="Buscar na lista…" value="' + esc(E.busca) + '">' +
            '<button class="imp-chip" data-acao="validar-todas" title="Valida todas as linhas marcadas que estão sem pendência"><svg class="ic ic-t"><use href="#i-check"/></svg>Validar todas</button>' +
            '<label class="imp-lembrar-todos"><input type="checkbox" data-campo="lembrarTodos"' + (E.lembrarTodos ? ' checked' : '') +
            '> Lembrar como regra</label>' +
            '<button class="imp-chip" data-acao="regras"><svg class="ic ic-t"><use href="#i-book"/></svg>Regras salvas</button></div>' +
            '<div class="imp-lista" id="imp-linhas"></div>' +
            '<div class="imp-rodape imp-fixo"><div id="imp-resumo"></div><div class="imp-acoes-fim">' +
            '<button class="imp-btn" data-acao="voltar2">Voltar</button>' +
            '<button class="imp-btn imp-primario" data-acao="confirmar" id="imp-confirmar">Importar</button></div></div>';
        desenharLinhas();
        atualizarResumo();
    }

    function visivel(l) {
        const f = E.filtro;
        if (f === 'importar' && !l.incluir) return false;
        if (f === 'naoval' && !(l.incluir && !l.validada)) return false;
        if (f === 'validadas' && !l.validada) return false;
        if (f === 'ignoradas' && l.incluir) return false;
        if (f === 'pendentes' && !(l.incluir && pendente(l))) return false;
        const b = normalizar(E.busca);
        return !b || normalizar(l.original + ' ' + l.nome).indexOf(b) >= 0;
    }

    function desenharLinhas() {
        let html = '', secaoAtual = -1;
        E.linhas.forEach(function (l) {
            if (!visivel(l)) return;
            if (l.secao !== secaoAtual) {
                secaoAtual = l.secao;
                html += '<div class="imp-sec-titulo">' + esc(E.fatura.secoes[secaoAtual].rotulo) + '</div>';
            }
            html += htmlCard(l);
        });
        document.getElementById('imp-linhas').innerHTML = html || '<div class="imp-vazio">Nenhuma linha neste filtro.</div>';
    }

    function badgesDe(l) {
        const b = [];
        if (ROTULO_MOTIVO[l.motivo]) b.push('<span class="imp-badge ' + ROTULO_MOTIVO[l.motivo][1] + '">' + ROTULO_MOTIVO[l.motivo][0] + '</span>');
        l.avisos.forEach(function (a) { b.push('<span class="imp-badge imp-b-av">' + ROTULO_AVISO[a] + '</span>'); });
        return b.join(' ');
    }

    function textoParcela(l) {
        const t = parseInt(l.total, 10) || 1, a = parseInt(l.atual, 10) || 1;
        if (t <= 1) return 'à vista';
        return 'parcela ' + a + '/' + t + (a < t ? (l.modo === 'esta_e_seguintes' ? ' (+ as seguintes)' : ' (só esta)') : '');
    }

    function htmlResponsaveis(l) {
        const usados = l.div.map(function (d) { return d.pessoa_id; });
        const falta = faltaDiv(l.valor, l.div);
        let h = '<div class="imp-resp">';
        l.div.forEach(function (d, i) {
            h += '<div class="imp-resp-linha"><select data-campo="resp-pessoa" data-i="' + i + '">' + pessoas().map(function (p) {
                const ocupado = usados.indexOf(p.id) >= 0 && p.id !== d.pessoa_id;
                return '<option value="' + esc(p.id) + '"' + (p.id === d.pessoa_id ? ' selected' : '') + (ocupado ? ' disabled' : '') + '>' + esc(p.nome) + '</option>';
            }).join('') + '</select><span class="imp-rs">R$</span>' +
            '<input type="number" step="0.01" class="imp-valor-in" data-campo="resp-valor" data-i="' + i + '" value="' + d.valor + '">' +
            (l.div.length > 1 ? '<button class="imp-mini" data-acao="resp-remover" data-i="' + i + '" title="Remover responsável"><svg class="ic"><use href="#i-x"/></svg></button>' : '') + '</div>';
        });
        h += '<div class="imp-resp-acoes">' +
            (l.div.length < pessoas().length ? '<button class="imp-mini imp-mini-txt" data-acao="resp-adicionar">+ Responsável</button>' : '') +
            (l.div.length > 1 ? '<button class="imp-mini imp-mini-txt" data-acao="resp-igual">Dividir igual</button>' : '') +
            '<span class="imp-falta ' + (Math.abs(falta) > 0.005 ? 'imp-alerta' : 'imp-ok') + '">' + textoFalta(l) + '</span></div></div>';
        return h;
    }
    function textoFalta(l) {
        const f = faltaDiv(l.valor, l.div);
        if (Math.abs(f) <= 0.005) return '<svg class="ic ic-t"><use href="#i-check"/></svg>divisão confere';
        return f > 0 ? 'Falta distribuir ' + moeda(f) : 'Passou ' + moeda(-f) + ' do valor';
    }

    function htmlCard(l) {
        const valor = '<div class="imp-c-valor' + (l.valor < 0 ? ' imp-cred' : '') + '">' + moeda(l.valor) +
            (l.valorUsd ? '<div class="imp-mudo imp-peq">US$ ' + l.valorUsd + '</div>' : '') + '</div>';
        const cab = '<div class="imp-c-data">' + dataBR(l.data) + '</div>';

        if (l.validada) {                                    // trancada: uma linha só
            return '<div class="imp-card imp-validada" data-seq="' + l.seq + '"><div class="imp-c-sel"><svg class="ic"><use href="#i-check"/></svg></div>' + cab +
                '<div class="imp-c-info"><div>' + (l.fixo ? '<span class="imp-badge imp-b-av"><svg class="ic ic-t"><use href="#i-fixos"/></svg>Fixo</span> ' : '') + '<b>' + esc(l.nome) + '</b> <span class="imp-mudo imp-peq">' + esc(l.original) + '</span> ' + badgesDe(l) + '</div>' +
                '<div class="imp-mudo imp-peq">' + esc(nomeCategoria(l)) + ' · ' + textoParcela(l) + ' · ' +
                l.div.map(function (d) { return esc(nomePessoa(d.pessoa_id)) + ' ' + moeda(d.valor); }).join(' + ') +
                (l.vinculo ? ' · <svg class="ic ic-t"><use href="#i-link"/></svg>' + esc(l.vinculo.desc) : '') + '</div></div>' + valor +
                '<button class="imp-btn imp-btn-peq" data-acao="desvalidar">Desvalidar</button></div>';
        }
        if (!l.incluir) {                                    // ignorada: linha discreta
            if (l.absorvida) {
                const e = l.existente || {};
                return '<div class="imp-card imp-off imp-absorvida" data-seq="' + l.seq + '"><div class="imp-c-sel"><svg class="ic"><use href="#i-link"/></svg></div>' + cab +
                    '<div class="imp-c-info"><div><b>' + esc(l.original) + '</b> ' + badgesDe(l) + '</div><div class="imp-mudo imp-peq">Fica só o lançamento que você já tinha: “' + esc(e.desc) + '”' +
                    ((e.total_parcelas || 1) > 1 ? ' (parcela ' + e.parcela_atual + '/' + e.total_parcelas + ')' : '') + ' · ' + mesBR(e.mes_fatura) + '. Esta linha não será importada.</div></div>' + valor +
                    '<button class="imp-btn imp-btn-peq" data-acao="desvincular">Desvincular</button></div>';
            }
            const ex = l.existente ? ' · parecida com “' + esc(l.existente.desc) + '” (' + mesBR(l.existente.mes_fatura) + ')' : '';
            return '<div class="imp-card imp-off" data-seq="' + l.seq + '"><div class="imp-c-sel"><input type="checkbox" data-campo="incluir" title="Importar esta linha"></div>' + cab +
                '<div class="imp-c-info"><div><b>' + esc(l.original) + '</b> ' + badgesDe(l) + '</div><div class="imp-mudo imp-peq">Não será importada' + ex + '</div></div>' + valor +
                '<button class="imp-btn imp-btn-peq" data-acao="vincular"><svg class="ic ic-t"><use href="#i-link"/></svg>Vincular</button></div>';
        }
        const pend = pendente(l);
        const cat = categorias().find(function (c) { return c.id === l.cat_id; });
        const subs = cat && cat.subcategorias ? cat.subcategorias : [];
        const parcelado = (parseInt(l.total, 10) || 1) > 1 && (parseInt(l.atual, 10) || 1) < (parseInt(l.total, 10) || 1);
        return '<div class="imp-card imp-edit' + (pend ? ' imp-pend' : '') + '" data-seq="' + l.seq + '">' +
            '<div class="imp-c-topo"><label class="imp-c-sel"><input type="checkbox" data-campo="incluir" checked title="Importar esta linha"></label>' + cab +
            '<div class="imp-c-info"><b class="imp-orig">' + esc(l.original) + '</b> ' + badgesDe(l) + '</div>' + valor + '</div>' +
            '<div class="imp-campos">' +
              '<div class="imp-campo imp-c-nome"><label>Nome</label><input type="text" data-campo="nome" value="' + esc(l.nome) + '">' +
                '<label class="imp-regra"><input type="checkbox" data-campo="lembrar"' + (l.lembrar ? ' checked' : '') + '> lembrar nas próximas faturas</label>' +
                '<label class="imp-regra imp-fixo-chk" title="Aparece também em Gastos Fixos, sem somar duas vezes"><input type="checkbox" data-campo="fixo"' + (l.fixo ? ' checked' : '') + '> <svg class="ic ic-t"><use href="#i-fixos"/></svg>dívida fixa (aparece em Gastos Fixos)</label></div>' +
              '<div class="imp-campo"><label>Categoria</label><select data-campo="cat_id"><option value="">Sem categoria</option>' + categorias().map(function (c) {
                  return '<option value="' + esc(c.id) + '"' + (c.id === l.cat_id ? ' selected' : '') + '>' + esc(c.nome) + '</option>'; }).join('') + '</select></div>' +
              '<div class="imp-campo"><label>Subcategoria</label><select data-campo="subcat_id"' + (subs.length ? '' : ' disabled') + '><option value="">—</option>' + subs.map(function (x) {
                  return '<option value="' + esc(x.id) + '"' + (x.id === l.subcat_id ? ' selected' : '') + '>' + esc(x.nome) + '</option>'; }).join('') + '</select></div>' +
              '<div class="imp-campo imp-c-parc"><label>Parcela</label><div class="imp-parc"><input type="number" min="1" max="120" class="imp-n" data-campo="atual" value="' + l.atual + '"> de ' +
                '<input type="number" min="1" max="120" class="imp-n" data-campo="total" value="' + l.total + '"></div>' +
                (parcelado ? '<select data-campo="modo"><option value="esta_e_seguintes"' + (l.modo === 'esta_e_seguintes' ? ' selected' : '') + '>Esta e as seguintes</option>' +
                  '<option value="so_esta"' + (l.modo === 'so_esta' ? ' selected' : '') + '>Só esta</option></select>' : '') + '</div>' +
            '</div>' +
            '<div class="imp-campo imp-c-resp"><label>Quem deve este valor</label>' + htmlResponsaveis(l) + '</div>' +
            '<div class="imp-c-rodape">' +
              (l.vinculo ? '<span class="imp-vinc"><svg class="ic ic-t"><use href="#i-link"/></svg>Vinculada a “' + esc(l.vinculo.desc) + '” (' + l.vinculo.parcela_atual + '/' + l.vinculo.total_parcelas + ' · ' + mesBR(l.vinculo.mes_fatura) + ') ' +
                  '<button class="imp-mini imp-mini-txt" data-acao="desvincular">Desvincular</button></span>'
                : '<button class="imp-btn imp-btn-peq" data-acao="vincular"><svg class="ic ic-t"><use href="#i-link"/></svg>Vincular a lançamento já feito</button>') +
              '<button class="imp-btn imp-btn-peq imp-validar" data-acao="validar"' + (pend ? ' disabled title="Preencha o nome e feche a divisão para validar"' : '') + '><svg class="ic ic-t"><use href="#i-check"/></svg>Validar</button>' +
            '</div></div>';
    }

    function atualizarResumo() {
        const r = resumo(E.linhas);
        const conf = E.fatura.conferencia || {};
        const el = document.getElementById('imp-resumo');
        if (!el) return;
        el.innerHTML = '<b>' + r.importar + '</b> a importar · <b>' + moeda(r.total) + '</b> · <span class="imp-ok">' + r.validadas + ' validadas</span>' +
            (r.naoValidadas ? ' · ' + r.naoValidadas + ' por validar' : '') + ' · ' + r.ignoradas + ' ignoradas' +
            (r.pendentes ? ' · <span class="imp-alerta">' + r.pendentes + ' com pendência</span>' : '') +
            '<div class="imp-mudo imp-peq">Total do PDF: ' + moeda(E.fatura.total_fatura) + (conf.ok ? ' (conferido <svg class="ic"><use href="#i-check"/></svg>)' : '') +
            (r.importar && r.naoValidadas ? ' · valide todas as linhas marcadas para poder importar' : '') + '</div>';
        const b = document.getElementById('imp-confirmar');
        if (b) b.disabled = !r.importar || r.pendentes > 0 || r.naoValidadas > 0;
    }

    function achar(el) {
        const c = el.closest('[data-seq]');
        return c ? E.linhas.find(function (l) { return String(l.seq) === c.dataset.seq; }) : null;
    }
    function redesenharLinha(l) {
        const antigo = raiz.querySelector('#imp-linhas [data-seq="' + l.seq + '"]');
        if (!antigo) return;
        if (!visivel(l)) { antigo.remove(); return; }
        const tmp = document.createElement('div');
        tmp.innerHTML = htmlCard(l);
        antigo.replaceWith(tmp.firstElementChild);
    }
    function redesenharPropagadas(origem) {
        E.linhas.forEach(function (x) { if (x !== origem && normalizar(x.descricao) === normalizar(origem.descricao)) redesenharLinha(x); });
    }
    function mudou(l, propagados) {
        redesenharLinha(l);
        if (propagados && propagados.length) { propagar(E.linhas, l, propagados); redesenharPropagadas(l); }
        atualizarResumo();
    }

    function aoMudar(ev) {
        const el = ev.target, campo = el.dataset.campo;
        if (!campo || !E) return;
        if (campo === 'nome' || campo === 'resp-valor') return;   // tratados em aoDigitar (não redesenhar aqui)
        if (campo === 'cartao') { E.mapeamento[el.dataset.secao] = el.value; return; }
        if (campo === 'mes') { E.mes = el.value; return; }
        if (campo === 'lembrarTodos') {
            E.lembrarTodos = el.checked;
            E.linhas.forEach(function (x) { if (x.incluir && !x.validada) x.lembrar = el.checked; });
            return desenharLinhas();
        }
        const l = achar(el);
        if (!l || l.validada) return;
        if (campo === 'incluir') { l.incluir = el.checked; if (l.incluir && E.lembrarTodos) l.lembrar = true; return mudou(l); }
        if (campo === 'lembrar') { l.lembrar = el.checked; return; }
        if (campo === 'fixo') { l.fixo = el.checked; l.tocada = true; propagar(E.linhas, l, ['fixo']); E.linhas.forEach(function (x) { if (x !== l) redesenharLinha(x); }); return; }
        if (campo === 'cat_id') { l.cat_id = el.value; l.subcat_id = ''; l.tocada = true; return mudou(l, ['cat_id', 'subcat_id']); }
        if (campo === 'subcat_id') { l.subcat_id = el.value; l.tocada = true; return mudou(l, ['subcat_id']); }
        if (campo === 'modo') { l.modo = el.value; return mudou(l); }
        if (campo === 'resp-pessoa') { l.div[parseInt(el.dataset.i, 10)].pessoa_id = el.value; l.tocada = true; return mudou(l, ['div']); }
        if (campo === 'atual' || campo === 'total') {
            let v = parseInt(el.value, 10); if (!(v >= 1)) v = 1;
            l[campo] = Math.min(v, 120);
            if (l.atual > l.total) { if (campo === 'atual') l.total = l.atual; else l.atual = l.total; }
            if (l.total > 1 && l.atual < l.total && l.modo !== 'so_esta' && l.modo !== 'esta_e_seguintes') l.modo = 'esta_e_seguintes';
            return mudou(l);
        }
    }

    function aoDigitar(ev) {
        const el = ev.target, campo = el.dataset.campo;
        if (el.id === 'imp-busca' && E) { E.busca = el.value; return desenharLinhas(); }
        if (el.id === 'imp-busca-vinculo' && E) { E.buscaVinculo = el.value; return listaVinculo(); }
        if (!E || !campo) return;
        const l = achar(el);
        if (!l || l.validada) return;
        if (campo === 'nome') {
            l.nome = el.value; l.tocada = true;
            propagar(E.linhas, l, ['nome']);
            E.linhas.forEach(function (x) {                  // atualiza só o texto das iguais (sem tirar o foco)
                if (x === l || x.validada) return;
                const campoX = raiz.querySelector('[data-seq="' + x.seq + '"] input[data-campo="nome"]');
                if (campoX && campoX.value !== x.nome) campoX.value = x.nome;
            });
            const botao = el.closest('.imp-card').querySelector('[data-acao="validar"]');
            if (botao) botao.disabled = pendente(l);
            el.closest('.imp-card').classList.toggle('imp-pend', pendente(l));
            atualizarResumo();
        } else if (campo === 'resp-valor') {
            const d = l.div[parseInt(el.dataset.i, 10)];
            d.valor = parseFloat(el.value) || 0; l.tocada = true;
            const card = el.closest('.imp-card');
            const falta = card.querySelector('.imp-falta');
            falta.textContent = textoFalta(l);
            falta.className = 'imp-falta ' + (Math.abs(faltaDiv(l.valor, l.div)) > 0.005 ? 'imp-alerta' : 'imp-ok');
            card.classList.toggle('imp-pend', pendente(l));
            const botao = card.querySelector('[data-acao="validar"]');
            if (botao) botao.disabled = pendente(l);
            atualizarResumo();
        }
    }

    function adicionarResp(l) {
        const livre = pessoas().find(function (p) { return !l.div.some(function (d) { return d.pessoa_id === p.id; }); });
        if (!livre) return;
        const ids = l.div.map(function (d) { return d.pessoa_id; }).concat([livre.id]);
        l.div = dividirIgual(l.valor, ids);          // ao adicionar alguém, divide igual entre todos
    }

    // Seleção de arquivo
    document.addEventListener('change', function (ev) {
        if (ev.target && ev.target.id === 'imp-arq' && E) {
            E.arquivoObj = ev.target.files[0] || null; E.erro = '';
            const span = ev.target.parentNode.querySelector('span');
            if (span) span.innerHTML = E.arquivoObj ? '<svg class="ic ic-t"><use href="#i-clip"/></svg>' + esc(E.arquivoObj.name) : 'Clique para escolher o arquivo…';
        }
        if (ev.target && ev.target.id === 'imp-todos-cartoes' && E) { E.vincTodos = ev.target.checked; listaVinculo(); }
    });
    document.addEventListener('keydown', function (ev) {
        if (!E) return;
        if (ev.key === 'Escape') {
            const gaveta = document.getElementById('imp-gaveta');
            if (gaveta) { gaveta.remove(); E.vinculando = null; return; }
            fechar(true);
        }
        if (ev.key === 'Enter' && E.passo === 1 && ev.target && ev.target.id === 'imp-senha') lerPdf();
    });

    async function aoClicar(ev) {
        const alvo = ev.target.closest('[data-acao]');
        if (!alvo || !E) return;
        const acao = alvo.dataset.acao;
        const l = alvo.closest('[data-seq]') ? achar(alvo) : null;
        if (acao === 'maximizar') { guardarGeom(); ampliada = !ampliada; posicionarJanela(); return; }
        if (acao === 'fechar') fechar(true);
        else if (acao === 'ler') lerPdf();
        else if (acao === 'voltar1') { E.passo = 1; E.erro = ''; desenhar(); }
        else if (acao === 'voltar2') { E.passo = 2; E.erro = ''; desenhar(); }
        else if (acao === 'analisar') analisar();
        else if (acao === 'filtro') { E.filtro = alvo.dataset.v; corpoPasso3(); }
        else if (acao === 'regras') painelRegras();
        else if (acao === 'confirmar') confirmar();
        else if (acao === 'validar-todas') {
            E.linhas.forEach(function (x) { if (x.incluir && !pendente(x)) x.validada = true; });
            desenharLinhas(); atualizarResumo();
        }
        else if (acao === 'validar' && l && !pendente(l)) { l.validada = true; mudou(l); }
        else if (acao === 'desvalidar' && l) { l.validada = false; mudou(l); }
        else if (acao === 'vincular' && l) abrirGaveta(l);
        else if (acao === 'desvincular' && l) {
            l.vinculo = null; l.compra_pai = null;
            if (l.absorvida) { l.absorvida = false; l.incluir = true; l.motivo = 'nova'; l.existente = null; }   // desfez a absorção: volta a ser lançamento novo
            mudou(l);
        }
        else if (acao === 'vinc-escolher') escolherVinculo(alvo.dataset.id);
        else if (acao === 'gaveta-fechar') { const g = document.getElementById('imp-gaveta'); if (g) g.remove(); E.vinculando = null; }
        else if (acao === 'resp-adicionar' && l && !l.validada) { adicionarResp(l); l.tocada = true; mudou(l, ['div']); }
        else if (acao === 'resp-igual' && l && !l.validada) { l.div = dividirIgual(l.valor, l.div.map(function (d) { return d.pessoa_id; })); l.tocada = true; mudou(l, ['div']); }
        else if (acao === 'resp-remover' && l && !l.validada) {
            l.div.splice(parseInt(alvo.dataset.i, 10), 1);
            l.div = dividirIgual(l.valor, l.div.map(function (d) { return d.pessoa_id; })); l.tocada = true; mudou(l, ['div']);
        }
        else if (acao === 'apagar-regra') {
            await api('/api/importacao/regras/' + encodeURIComponent(alvo.dataset.id), { method: 'DELETE' });
            painelRegras(true);
        }
    }

    // ----- Vincular a um lançamento já feito -----
    function abrirGaveta(l) {
        E.vinculando = l.seq; E.buscaVinculo = ''; E.vincTodos = false;
        const antiga = document.getElementById('imp-gaveta');
        if (antiga) antiga.remove();
        const g = document.createElement('div');
        g.className = 'imp-gaveta'; g.id = 'imp-gaveta';
        g.innerHTML = '<div class="imp-topo"><div><h3><svg class="ic ic-t"><use href="#i-link"/></svg>Vincular a lançamento já feito</h3><div class="imp-mudo imp-peq">' + esc(l.original) + ' · ' + moeda(l.valor) + '</div></div>' +
            '<button class="imp-x" data-acao="gaveta-fechar"><svg class="ic"><use href="#i-x"/></svg></button></div>' +
            '<p class="imp-mudo imp-peq imp-gaveta-ajuda">Escolha o lançamento do mês anterior (a mesma compra). O nome, a categoria, a parcela e quem deve serão copiados.</p>' +
            '<input type="search" id="imp-busca-vinculo" class="imp-busca" placeholder="Buscar pelo nome…">' +
            '<label class="imp-lembrar-todos imp-peq"><input type="checkbox" id="imp-todos-cartoes"> Mostrar também de outros cartões</label>' +
            '<div id="imp-vinc-lista" class="imp-vinc-lista"></div>';
        raiz.querySelector('.imp-janela').appendChild(g);
        listaVinculo();
        g.querySelector('#imp-busca-vinculo').focus();
    }

    function listaVinculo() {
        const l = E.linhas.find(function (x) { return x.seq === E.vinculando; });
        const alvo = document.getElementById('imp-vinc-lista');
        if (!l || !alvo) return;
        const lista = candidatosVinculo(typeof db_faturas !== 'undefined' ? db_faturas : [], l,
            { cartaoId: E.mapeamento[l.secao], mes: E.mes, busca: E.buscaVinculo, todosCartoes: E.vincTodos });
        alvo.innerHTML = lista.length ? lista.map(function (f) {
            const cartao = cartoes().find(function (c) { return c.id === f.cartao_id; });
            return '<div class="imp-vinc-item"><div><b>' + esc(f.desc) + '</b><div class="imp-mudo imp-peq">' +
                ((f.total_parcelas || 1) > 1 ? 'Parcela ' + f.parcela_atual + '/' + f.total_parcelas : 'À vista') + ' · ' + mesBR(f.mes_fatura) + ' · ' + moeda(f.valor_parcela) +
                (cartao ? ' · ' + esc(cartao.nome) : '') + '</div><div class="imp-mudo imp-peq">' + esc(nomeCategoria({ cat_id: f.cat_id, subcat_id: f.subcat_id })) + ' · ' +
                (f.divisao || []).map(function (d) { return esc(nomePessoa(d.pessoa_id)) + ' ' + moeda(d.valor); }).join(' + ') + '</div></div>' +
                '<button class="imp-btn imp-btn-peq" data-acao="vinc-escolher" data-id="' + esc(f.id) + '">Vincular</button></div>';
        }).join('') : '<div class="imp-vazio">Nada encontrado. Tente buscar pelo nome ou marque “outros cartões”.</div>';
    }

    function escolherVinculo(id) {
        const l = E.linhas.find(function (x) { return x.seq === E.vinculando; });
        const ex = (typeof db_faturas !== 'undefined' ? db_faturas : []).find(function (f) { return f.id === id; });
        const g = document.getElementById('imp-gaveta');
        if (g) g.remove();
        E.vinculando = null;
        if (!l || !ex) return;
        const r = aplicarVinculo(l, ex, E.mes, db_faturas);
        mudou(l);
        aviso(r.jaLancada ? 'Essa parcela já existe no sistema: fica só o lançamento antigo e esta linha não será importada.' : 'Vinculada! Dados copiados do lançamento anterior.', 'ok');
    }

    async function painelRegras(soAtualizar) {
        const regras = await api('/api/importacao/regras');
        const caixa = document.createElement('div');
        caixa.className = 'imp-gaveta';
        caixa.id = 'imp-regras';
        caixa.innerHTML = '<div class="imp-topo"><h3><svg class="ic ic-t"><use href="#i-book"/></svg>Regras salvas</h3><button class="imp-x" data-acao="regras-fechar"><svg class="ic"><use href="#i-x"/></svg></button></div>' +
            (regras.length ? regras.map(function (r) {
                const cat = categorias().find(function (c) { return c.id === r.cat_id; });
                return '<div class="imp-regra-item"><div><b>' + esc(r.nome) + '</b><div class="imp-mudo imp-peq">Quando a fatura tiver “' + esc(r.padrao) + '”' +
                    (cat ? ' → ' + esc(cat.nome) : '') + ' · usada ' + r.usos + ' vez(es)</div></div>' +
                    '<button class="imp-btn imp-btn-peq" data-acao="apagar-regra" data-id="' + esc(r.id) + '">Apagar</button></div>';
            }).join('') : '<p class="imp-mudo">Ainda não há regras. Marque “lembrar” numa linha ao importar.</p>');
        const antiga = document.getElementById('imp-regras');
        if (antiga) antiga.remove();
        raiz.querySelector('.imp-janela').appendChild(caixa);
        caixa.querySelector('[data-acao="regras-fechar"]').addEventListener('click', function () { caixa.remove(); });
    }

    async function confirmar() {
        const r = resumo(E.linhas);
        if (!r.importar || r.pendentes || r.naoValidadas) return;
        const texto = 'Importar ' + r.importar + ' lançamentos (' + moeda(r.total) + ') para ' + mesBR(E.mes) + '?\n\n' +
            'Se algo ficar errado, é só apertar Ctrl+Z para desfazer tudo de uma vez.';
        if (!global.confirm(texto)) return;
        const botao = document.getElementById('imp-confirmar');
        botao.disabled = true; botao.textContent = 'Importando…';
        const res = await api('/api/importacao/confirmar', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(montarPayload(E))
        });
        if (!res.ok) {
            botao.disabled = false; botao.textContent = 'Importar';
            global.alert(res.mensagem || 'Não foi possível importar.');
            return;
        }
        fechar(false);
        if (global.recarregarDoServidor) await global.recarregarDoServidor();
        aviso(res.linhas + ' lançamentos criados. Ctrl+Z desfaz tudo.', 'ok');
    }

    global.abrirImportacao = abrir;
})(typeof window !== 'undefined' ? window : globalThis);
