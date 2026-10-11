# Gofre — controle financeiro pessoal

Programa de Windows (Flask + SQLite + JavaScript puro) para controlar gastos, cartões, entradas, orçamento e relatórios.
Os dados ficam **só no seu computador** (`%APPDATA%\Financeiro\memoria`) — nada é enviado para a internet.

## Instalar (uso normal)
1. Abra a aba **Releases** deste repositório e baixe o `Instalar_Financeiro_x.y.z.exe` da versão mais recente.
2. Dê dois cliques e siga o instalador. Seus dados nunca são apagados ao atualizar.
3. Para atualizar: baixe e rode o instalador novo por cima.

## Rodar a partir do código (desenvolvimento)
```
py -m pip install -r requirements-desktop.txt
py main.py          # janela própria     |   py app.py → abre no navegador
py -m pip install -r requirements-dev.txt && py -m pytest -q   # testes
```

## Lançar uma versão nova
Altere `APP_VERSAO` (app.py) e `Versao` (instalador.iss), faça commit e crie a etiqueta:
`git tag v2.6.0 && git push --tags`. O GitHub monta o instalador sozinho e publica em Releases.

## Privacidade
Nunca envie para o GitHub: a pasta `memoria`, arquivos `.db`, PDFs de fatura e `senhas_pdf.json` (já estão no `.gitignore`).

---

## Estrutura atual (Fase 2)

```
Financeiro/
├── app.py                    servidor + banco + backups + histórico (desfazer/refazer)
├── main.py                   abre o sistema como programa de Windows (janela própria)
├── desktop/                  janela, bandeja, instância única, caminhos dos dados
├── assets/                   ícone do programa
├── Iniciar_Sistema.bat       jeito antigo (abre no navegador) — continua funcionando
├── Abrir_Como_Programa.bat   abre numa janela própria (teste, sem criar o .exe)
├── construir_programa.bat    cria o programa Financeiro.exe
├── criar_atalho.bat          cria o atalho na Área de Trabalho
├── construir_instalador.bat  (opcional) cria um instalador
├── financeiro.spec / instalador.iss   receitas usadas pelos .bat acima
├── rodar_testes.bat          roda os testes automáticos
├── requirements*.txt         listas de componentes
├── templates/index.html
├── static/css/style.css
├── static/fonts/             fonte ZT Nature (vai junto no programa; não precisa de internet)
├── static/js/script.js
├── tests/                    testes automáticos (backups, histórico, janela, fluxo de abertura)
└── legacy/                   cópia congelada da versão original
```

## Programa de Windows (Fase 2)

Três jeitos de abrir, do mais simples ao mais completo:

1. **`Iniciar_Sistema.bat`** — jeito antigo, abre no navegador. Continua funcionando.
2. **`Abrir_Como_Programa.bat`** — abre numa janela própria, sem criar o .exe. Usa os mesmos dados do .exe.
3. **`Financeiro.exe`** — programa de verdade (gerado por `construir_programa.bat`).

### Onde ficam os dados (um só lugar, para todos os jeitos de abrir)
`%APPDATA%\Financeiro\memoria` (cole esse caminho na barra do Explorer).
Vale para o .exe, para o `Abrir_Como_Programa.bat` e para o `Iniciar_Sistema.bat`:
existe **um único banco**. Mover a pasta do projeto, atualizar ou reinstalar o programa **não afeta os dados**.

Se ainda não existir banco ali, o programa **copia** o `financeiro.db` de uma pasta `memoria` ao lado do projeto (se achar).
Nunca sobrescreve um banco que já existe.

Dentro de `%APPDATA%\Financeiro` ficam também `config.json` (preferências) e `erro_de_abertura.txt` (só se der erro).

### Ícone da bandeja (perto do relógio)
Clique com o botão direito: Abrir, Fazer backup agora, Abrir pasta de dados,
Backup externo (Drive), Iniciar com o Windows, Fechar a janela envia para a bandeja, Sair.
Por padrão, ao clicar no X o programa continua na bandeja. Use **Sair** para fechar de verdade.

### Só uma cópia aberta
Abrir o programa de novo apenas traz a janela já aberta para a frente.

### Se der erro ao abrir
O .exe grava os detalhes em `%APPDATA%\Financeiro\erro_de_abertura.txt`. Envie esse arquivo.

### Instalador (instalar e atualizar sem perder dados)
Uma vez, instale o **Inno Setup 6** (gratuito: https://jrsoftware.org/isdl.php).

Para gerar uma versão nova do instalador:
1. Dê dois cliques em `construir_programa.bat` (monta o programa em `dist\Financeiro`).
2. Dê dois cliques em `construir_instalador.bat` (cria `instalador\Instalar_Financeiro_<versão>.exe`).

Para instalar ou atualizar: abra o `Instalar_Financeiro_<versão>.exe`. **Instalar por cima atualiza o programa**
(ele fecha a cópia que estiver na bandeja, troca os arquivos e abre de novo). Os dados ficam em
`%APPDATA%\Financeiro` e **não são tocados** (nem ao atualizar, nem ao desinstalar).

Antes de lançar uma versão nova, aumente o número em `instalador.iss` (linha `#define Versao`).
A senha dos PDFs de fatura **não vai dentro do instalador**: na primeira importação o programa pede a senha
e guarda em `%APPDATA%\Financeiro` para as próximas.

### Atualizar o programa depois de mudanças
Dê dois cliques em `Atualizar_Programa.bat`. Ele cria o programa novo, monta o instalador e instala por cima do antigo
(seus dados ficam intactos). Só precisa do Python e do Inno Setup, como antes.

## Importar fatura em PDF (Fase 3)
Botão **📄 Importar Fatura** (barra de cima). Funciona com faturas **XP** e **Inter**.

1. Escolha o PDF. Ele é só **lido na hora** — o arquivo nunca é guardado.
2. Diga a qual cartão do sistema pertence cada parte da fatura e confirme o mês (o do vencimento).
3. Revise a lista (tela cheia, um cartão por linha da fatura): nome, categoria, parcela e **quem deve quanto (em R$)**.
   Ao adicionar um responsável, o valor é dividido igualmente entre todos; dá para ajustar cada valor.
   Linhas que já existem no sistema vêm **desmarcadas** (aviso "Já lançada" ou "Provável duplicada").
   - **🔗 Vincular a lançamento já feito:** escolha a compra do mês anterior; nome, categoria, parcela e
     responsáveis são copiados e a parcela entra na mesma compra.
   - **✓ Validar:** tranca a linha (fica numa linha só, verde). **Desvalidar** destranca. **Validar todas** valida as
     linhas sem pendência. O botão Importar só libera quando todas as linhas marcadas estão validadas.
4. Clique em **Importar**. Tudo entra numa única ação: **Ctrl+Z desfaz a importação inteira**.

- Marque **lembrar** numa linha para o programa aplicar o mesmo nome/categoria/divisão nas próximas faturas
  (lista em **📚 Regras salvas**).
- Parcelas: "Esta e as seguintes" cria as parcelas que faltam nos meses seguintes.
- A soma das linhas é conferida com o total impresso no PDF (pagamentos não entram na conta).
- **Senhas dos PDFs:** ficam no arquivo `senhas_pdf.json` (ex.: `["124188", "12418"]`). Na primeira vez o
  programa copia esse arquivo para `%APPDATA%\Financeiro`; depois você pode apagar o da pasta do projeto.
  Se nenhuma senha servir, a tela pede a senha e passa a lembrá-la. Esse arquivo não vai para o git.

## Relatórios e Fechar mês
- Botão **📈 Relatórios**: compara os últimos 3, 6 ou 12 meses (entradas, gastos e saldo), mostra a evolução de cada categoria
  e o gráfico da categoria escolhida (clique na linha dela). Conta pelo **mês da fatura** e só a **sua parte**
  (gastos de outras pessoas não entram). Meses futuros aparecem com \* (previsão).
- Aba **Fechar mês**: guarda uma foto dos números do mês. Não trava nada; se algo mudar depois, o programa avisa.
  Dá para reabrir e para desfazer com Ctrl+Z.
- **Busca global**: ao escolher um resultado, o programa abre o mês certo e faz a linha piscar.

## Lançar pelo Telegram (gratuito)
Você manda o gasto por mensagem para o seu próprio bot, escolhe cartão/categoria/pessoa nos botões e ele entra
no cartão do mês certo (com Ctrl+Z, como qualquer lançamento).

**Configurar (uma vez):** Configs → 🤖 Lançar pelo Telegram. A tela explica o passo a passo
(criar o bot com o @BotFather, colar o token, mandar /start para descobrir o seu número de usuário e ligar).

**Usar:** mande, por exemplo, `45,90 uber`, `mercado 120 ontem`, `notebook 3000 em 10x` (o valor é o total) ou
`academia 129,90 05/10`. Se o gasto já foi classificado antes, o bot preenche tudo e basta tocar em **Lançar**.
Ele avisa se parecer duplicado e lembra a classificação para a próxima vez (botão “Lembrar”).

**Cuidados:** o token fica em `%APPDATA%\Financeiro\telegram.json` (nunca no código nem no banco). O bot só obedece ao
seu número de usuário. Só funciona com o programa aberto (pode ficar na bandeja); mensagens enviadas com o computador
desligado ficam guardadas pelo Telegram por cerca de 24 h.

**Prints (leitura automática, 100% local e gratuita):** mande ao bot um print do XP ou do Inter — notificação de compra
(uma compra) ou lista de lançamentos (várias). O programa lê com OCR no próprio computador (RapidOCR, `telegram_bot/ocr.py`);
a imagem fica só na memória, nunca é gravada nem enviada a terceiros. Regras fixas:
- só **valor** e **nome** vêm do print; a **data nunca** vem da imagem (é hoje, ou o que você escolher no botão 📅 ou na legenda, ex.: `ontem`, `05/10`, `3x`);
- a **categoria do banco é ignorada**: você escolhe sempre;
- em lista, o bot mostra as compras para marcar (⚠️ = parece já lançada, vem desmarcada) e lança uma de cada vez, mantendo o cartão;
- o "final do cartão" (ex.: 7991) é lembrado depois do primeiro lançamento (em `telegram.json`);
- botão ✏️ Corrigir permite acertar nome/valor quando o OCR errar.
Se o motor de OCR não carregar, o bot avisa e continua aceitando texto.

**Memória por estabelecimento:** o bot preenche categoria/pessoas pela regra salva (🧠 Lembrar) e, se não houver regra,
sugere pelo que você já classificou nas faturas para o mesmo estabelecimento (`dados.sugerir_do_historico`) — sempre com
aviso "Confira". **Programa desligado:** mensagens enviadas enquanto o programa estava fechado (Telegram guarda ~24 h)
entram numa fila e aparecem uma de cada vez, com a data do dia em que você as enviou ("enviada em 08/10"). Ao voltar
depois de 30 min ou mais, o bot manda "🟢 Voltei!" (desligável em Configs → Telegram; o horário da última vez ligado
fica em `telegram_visto.json`).

**Tela sempre atualizada:** quando o bot (ou qualquer outra origem) grava algo, a tela se atualiza sozinha em poucos
segundos. Se você estiver editando justo nesse instante, o programa recusa a gravação velha, recarrega e avisa, para
nunca apagar o lançamento recém-chegado.

## Dívida fixa paga no cartão
Ao lançar no cartão (ou ao revisar uma fatura em PDF) marque **🔁 É uma dívida fixa** (academia, internet, telefone…).
Ela passa a aparecer também na aba **Gastos Fixos**, na seção "Fixos pagos no cartão", **sem ser somada duas vezes**:
o dashboard, o orçamento e o saldo continuam contando o valor só na fatura. Para marcar/desmarcar algo já lançado,
clique no item da fatura e use **🔁 Marcar fixo / Tirar de fixos** (vale para todas as parcelas da compra).
Na importação, "lembrar nas próximas faturas" também lembra que aquela dívida é fixa.

## Backups automáticos

Ficam em `memoria/backups/`. O nome indica o tipo:

| Tipo        | Quando é criado                                   | Quantos guarda |
|-------------|---------------------------------------------------|----------------|
| `abertura`  | toda vez que o programa é aberto                  | 15 |
| `diario`    | na primeira gravação de cada dia                  | 30 |
| `auto`      | antes de gravar, se o último backup tem >5 min    | 20 |
| `reducao`   | quando a trava bloqueia uma gravação suspeita     | 30 |

### Backup do backup (cópia para o Google Drive)
Na primeira abertura o programa pergunta se você quer escolher uma pasta do Drive
(por exemplo `G:\Meu Drive\Financeiro_Backups`). Depois disso **cada backup também é copiado para lá**,
com os mesmos limites de quantidade. Pode mudar ou desligar a qualquer momento pelo ícone da bandeja.

- Só são copiados backups **prontos** (arquivos fechados), nunca o banco em uso. Isso evita corromper por sincronização.
- Se a pasta ficar inacessível (Drive fechado, pasta apagada), o programa avisa ao abrir e **continua fazendo os backups locais**.
- Cada cópia aparece com o nome final só quando está completa (não sobra arquivo pela metade).

### Como restaurar um backup
1. Feche o programa (ícone da bandeja -> Sair).
2. Abra a pasta de dados (`%APPDATA%\Financeiro\memoria`).
3. Renomeie `financeiro.db` para `financeiro_com_problema.db` (não apague).
4. Copie o backup desejado para essa pasta e renomeie para `financeiro.db`.
   O backup pode vir de `backups\` (local) ou da pasta do Drive.
5. Abra o programa.

### Se o computador pifar (ou ao trocar de computador)
1. Instale o programa no computador novo (pasta do projeto + `construir_programa.bat`).
2. Abra o programa uma vez e feche (isso cria `%APPDATA%\Financeiro\memoria`).
3. Baixe do Drive o backup mais recente (o nome tem a data e a hora) e coloque como `financeiro.db`, como acima.

## Trava de segurança
Se uma alteração fosse apagar muitos registros de uma só vez (sobrar menos de 70%
de uma tabela com 5+ itens, ou zerar uma tabela com 3+ itens), o servidor recusa e o
programa pergunta se é intencional. Cancelando, nada é alterado e a tela volta ao
estado real do banco.

## Desfazer e Refazer (Fase 1)

Dois botões no canto inferior esquerdo da tela, e atalhos de teclado:

| Ação    | Atalho                      |
|---------|-----------------------------|
| Desfazer | Ctrl+Z                      |
| Refazer  | Ctrl+Y  ou  Ctrl+Shift+Z    |

Passe o mouse sobre o botão para ver o que será desfeito (ex.: "Desfazer: Excluiu “Netflix”").

Como funciona:
- Cada ação guarda **só o que mudou** (um lançamento, uma edição, uma exclusão). Desfazer nunca volta o sistema inteiro para o passado.
- Parcelamentos (12x) e ações que mexem em várias coisas ao mesmo tempo contam como **uma** ação.
- Editar o mesmo valor várias vezes seguidas conta como uma ação só.
- Os gastos fixos gerados automaticamente ao trocar de mês não entram no histórico.
- Fazer uma ação nova apaga a lista de "refazer" (igual ao Word).
- O histórico fica salvo no banco: continua valendo depois de fechar o programa.
- Guarda as últimas 300 ações.
- Dentro de um campo de texto, o Ctrl+Z continua desfazendo a digitação normalmente.

## Git (versionamento) — passo a passo
Na pasta do projeto, no terminal:

```
git init
git add .
git commit -m "Fase 0: backups, trava de seguranca e testes"
git tag fase-0
```

Antes de cada fase nova, repita `git add .`, `git commit` e `git tag fase-N`.
Para voltar a uma versão: `git checkout fase-0` (e `git checkout main` para retornar).

Antes do primeiro commit, crie a pasta `legacy/` e copie para dentro os 5 arquivos
da versão anterior (app.py, index.html, style.css, script.js, Iniciar_Sistema.bat).

## Testes
Dê dois cliques em `rodar_testes.bat`. Requisitos: `py -m pip install -r requirements-dev.txt`
e Node.js instalado (https://nodejs.org). Rode os testes sempre que alterar algo.
