# Downloader Reverso 🐢

Agente Node.js para Termux que recebe tarefas diretamente da Melissa Downloader API e usa a conexão de internet do A10s para baixar vídeos ou áudios públicos do YouTube com `yt-dlp`. O arquivo é enviado de volta à própria API em fluxo binário; o Hostless não precisa baixar o conteúdo diretamente do YouTube.

## Fluxo

1. A API principal esgota seus métodos normais de download.
2. A API chama o endpoint autenticado `/reverse-download` do relay.
3. O relay coloca a tarefa em uma fila própria do downloader reverso.
4. O agente no Termux recebe a tarefa por polling e executa `yt-dlp` no A10s.
5. O agente envia o arquivo ao relay, que transmite os bytes de volta à API principal.

O canal usa o mecanismo de polling já existente no relay, mas tem fila e endpoints separados das tarefas IPTV para não consumir requisições do player.

## Requisitos no Termux

```bash
pkg update
pkg install nodejs-lts python ffmpeg
python -m pip install -U "yt-dlp[default]"
git clone https://github.com/chirusanrestart/downloader-reverso.git
cd downloader-reverso
cp .env.example .env
```

Edite `.env` e informe a mesma `API_KEY` privada configurada na Melissa Downloader API e nos Secrets do Hostless relay. Ela deve ter pelo menos 32 caracteres.

```bash
npm test
npm start
```

Mantenha o processo ativo no Termux. O agente usa arquivos temporários e os remove após enviar a resposta.

## Variáveis

| Variável | Uso |
|---|---|
| `API_KEY` | Chave privada compartilhada entre agente, relay e API |
| `RELAY_URL` | Base do relay, padrão `https://melissa-iptv.hostless.app` |
| `YTDLP_PATH` | Caminho opcional do executável yt-dlp |
| `DOWNLOAD_TIMEOUT_MS` | Timeout do yt-dlp, padrão 600000 ms |

## Configuração dos servidores

No Hostless do `melissa-iptv`, configure `API_KEY` com o mesmo valor usado na API principal.

Na Melissa Downloader API, configure apenas:

- `REVERSE_AGENT_URL=https://melissa-iptv.hostless.app/reverse-download`

A `API_KEY` já existente é reutilizada. Não crie um segundo token.

Não publique o `.env` nem coloque o segredo no GitHub.

## Limites e segurança

- Aceita somente URLs HTTPS de domínios oficiais do YouTube.
- Modos suportados: `video` (MP4 combinado quando disponível) e `audio` (M4A/AAC).
- Limite de arquivo: 500 MiB.
- O agente executa yt-dlp sem impersonação, usando a conexão normal do Termux/A10s.
- O endpoint do relay e o polling do agente exigem a mesma `API_KEY` privada.
- Use somente conteúdo que você tenha autorização para baixar.
