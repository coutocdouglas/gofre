/* Configurações > Lançar pelo Telegram. O token fica só no computador (arquivo telegram.json); a tela nunca recebe ele de volta inteiro. */
const Telegram = (() => {
    let estado = null, mensagem = '', timer = null;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    async function carregar() {
        try { estado = await (await fetch('/api/telegram/status')).json(); } catch (e) { estado = null; }
        desenhar();
    }
    function ultima(e) {
        const m = e.ultima_mensagem;
        if (!m) return 'Nenhuma mensagem recebida ainda desde que o programa abriu.';
        const h = new Date(m.quando * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return 'Última mensagem recebida às ' + h + (m.autorizado ? '.' : ' — mas o número de quem enviou (' + esc(m.de) + ') é diferente do que está salvo aqui. Corrija o campo abaixo.');
    }

    function desenhar() {
        const c = document.getElementById('conteudoTelegram');
        if (!c) return;
        if (!estado) { c.innerHTML = '<div class="tg-nota">Não consegui consultar o programa agora.</div>'; return; }
        const e = estado;
        let ponto = '', texto = '';
        if (!e.ativo) { texto = 'Desligado'; }
        else if (e.erro) { ponto = 'erro'; texto = 'Com problema'; }
        else if (e.rodando) { ponto = 'ok'; texto = 'Ligado' + (e.bot ? ' — @' + esc(e.bot) : ''); }
        else { texto = 'Conectando…'; }
        c.innerHTML =
            '<div class="tg-caixa"><div class="tg-estado"><span class="tg-ponto ' + ponto + '"></span>' + texto + '</div>' +
            (e.erro ? '<div class="tg-nota" style="color:var(--danger)">' + esc(e.erro) + '</div>' : '') +
            (e.ativo && e.rodando && !e.erro ? '<div class="tg-nota">' + ultima(e) + '</div>' : '') +
            (e.ativo && !e.usuario_id ? '<div class="tg-nota">Falta o seu número de usuário (passo 3 abaixo).</div>' : '') +
            '<div class="tg-nota">O bot só funciona com o programa aberto (pode ficar na bandeja). Mensagens enviadas com o computador desligado ' +
            'ficam guardadas pelo Telegram por cerca de 24 horas.</div></div>' +

            '<div class="tg-caixa"><b style="font-size:13px">Como configurar</b><ol class="tg-passos">' +
            '<li>No Telegram, procure por <b>@BotFather</b>, mande <b>/newbot</b> e escolha um nome. Ele entrega um <b>token</b> (um texto longo com “:”).</li>' +
            '<li>Cole o token aqui embaixo e salve.</li>' +
            '<li>Abra o seu bot no Telegram e mande <b>/start</b>. Ele responde com o seu <b>número de usuário</b>. Cole aqui e salve.</li>' +
            '<li>Ligue o bot e pronto: mande, por exemplo, <b>45,90 uber</b>.</li></ol></div>' +

            '<div class="form-group"><label>Token do bot' + (e.token_definido ? ' (já salvo: ' + esc(e.token_mascarado) + ')' : '') + '</label>' +
            '<input type="password" id="tg-token" class="form-control" autocomplete="off" placeholder="' + (e.token_definido ? 'Deixe vazio para manter o atual' : '123456789:ABC…') + '"></div>' +
            '<div class="form-group"><label>Seu número de usuário no Telegram</label>' +
            '<input type="text" id="tg-id" class="form-control" inputmode="numeric" value="' + esc(e.usuario_id || '') + '" placeholder="Aparece quando você manda /start para o bot"></div>' +
            '<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:12px;cursor:pointer"><input type="checkbox" id="tg-ativo" ' + (e.ativo ? 'checked' : '') + '> Ligar o bot quando o programa estiver aberto</label>' +
            '<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:12px;cursor:pointer"><input type="checkbox" id="tg-volta" ' + (e.avisar_volta !== false ? 'checked' : '') + '> Avisar no Telegram quando o programa voltar a ligar (depois de ficar desligado)</label>' +
            '<div class="tg-linha"><button class="btn-blue" onclick="Telegram.salvar()">Salvar</button>' +
            '<button class="btn-blue tg-sec" onclick="Telegram.testar()">Testar</button></div>' +
            (mensagem ? '<div class="tg-aviso">' + esc(mensagem) + '</div>' : '') +
            (e.token_definido ? '<div class="tg-linha"><button class="btn-blue tg-sec" onclick="Telegram.limpar()">Apagar o token</button></div>' : '');
    }
    async function enviar(url, corpo) {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
        return r.json();
    }
    async function salvar() {
        const corpo = { usuario_id: document.getElementById('tg-id').value.trim(), ativo: document.getElementById('tg-ativo').checked, avisar_volta: document.getElementById('tg-volta').checked };
        const t = document.getElementById('tg-token').value.trim();
        if (t) corpo.token = t;
        const r = await enviar('/api/telegram/config', corpo);
        mensagem = r.ok ? 'Salvo.' : (r.mensagem || 'Não foi possível salvar.');
        if (r.ok) estado = r;
        desenhar();
        acompanhar();
    }
    async function testar() {
        mensagem = 'Testando…'; desenhar();
        const r = await enviar('/api/telegram/testar');
        mensagem = r.mensagem || (r.ok ? 'Funcionou.' : 'Não funcionou.');
        desenhar();
    }
    async function limpar() {
        if (!confirm('Apagar o token salvo e desligar o bot?')) return;
        const r = await enviar('/api/telegram/config', { limpar_token: true });
        mensagem = 'Token apagado.'; if (r.ok) estado = r; desenhar();
    }
    // Enquanto a tela está aberta, atualiza o estado (Conectando… -> Ligado)
    function acompanhar() {
        clearInterval(timer);
        let n = 0;
        timer = setInterval(async () => {
            const visivel = !document.getElementById('view-config-telegram').classList.contains('hidden');
            if (!visivel || ++n > 20) { clearInterval(timer); return; }
            const ativo = document.activeElement && ['tg-token', 'tg-id'].includes(document.activeElement.id);
            if (ativo) return;
            try { estado = await (await fetch('/api/telegram/status')).json(); desenhar(); } catch (e) {}
        }, 2000);
    }
    function abrir() {
        document.getElementById('view-configs').classList.add('hidden');
        document.getElementById('view-config-telegram').classList.remove('hidden');
        mensagem = '';
        carregar(); acompanhar();
    }
    function voltar() {
        clearInterval(timer);
        document.getElementById('view-config-telegram').classList.add('hidden');
        document.getElementById('view-configs').classList.remove('hidden');
    }
    return { abrir, voltar, salvar, testar, limpar };
})();
function abrirTelegram() { Telegram.abrir(); }
