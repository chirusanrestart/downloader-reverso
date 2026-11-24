# Downloader Reverso 🐢

Agente Node.js para Termux que recebe tarefas diretamente da Melissa Downloader API e usa a conexão de internet do A10s para baixar vídeos ou áudios públicos do YouTube com `yt-dlp`. O arquivo é enviado de volta à própria API em fluxo binário; o Hostless não precisa baixar o conteúdo diretamente do YouTube.

## Fluxo

1. A API principal esgota seus métodos normais de download.
2. A API cria uma tarefa no endpoint autenticado `/reverse-download` hospedado nela mesma.
3. A própria API coloca a tarefa em sua fila do downloader reverso.
4. O agente no Termux mantém uma conexão WebSocket autenticada com a API e recebe a tarefa enviada pelo servidor assim que ela é criada; então executa `yt-dlp` no A10s.
5. O agente envia o arquivo diretamente à API, que transmite os bytes ao cliente.

A fila e os endpoints do downloader reverso pertencem exclusivamente à Melissa Downloader API. O servidor IPTV não participa desse fluxo.

## Requisitos no Termux

```bash
pkg update
pkg install nodejs-lts python ffmpeg
python -m pip install -U "yt-dlp[default]"
git clone https://github.com/chirusanrestart/downloader-reverso.git
cd downloader-reverso
cp .env.example .env
```

Edite `.env` e informe a mesma `API_KEY` privada configurada nos Secrets da Melissa Downloader API.

```bash
npm test
npm start
```

Mantenha o processo ativo no Termux. O agente usa arquivos temporários e os remove após enviar a resposta.

## Variáveis

| Variável | Uso |
|---|---|
| `API_KEY` | Mesma chave privada configurada na Melissa Downloader API |
| `API_URL` | URL base da Melissa Downloader API, padrão `https://melissa-api-server.hostless.app` |
| `YTDLP_PATH` | Caminho opcional do executável yt-dlp |
| `DOWNLOAD_TIMEOUT_MS` | Timeout do yt-dlp, padrão 600000 ms |

## Configuração dos servidores

Na Melissa Downloader API, configure a `API_KEY` normalmente. O próprio servidor hospeda a fila do downloader reverso e usa essa mesma chave para autenticar o agente Termux. Não é necessário configurar o Hostless do IPTV nem criar um segundo token.

Não publique o `.env` nem coloque o segredo no GitHub.

## Limites e segurança

- Aceita somente URLs HTTPS de domínios oficiais do YouTube.
- Modos suportados: `video` (MP4 combinado quando disponível) e `audio` (M4A/AAC).
- Limite de arquivo: 500 MiB.
- O agente executa yt-dlp sem impersonação, usando a conexão normal do Termux/A10s.
- A conexão WebSocket do agente e o endpoint de resposta exigem a mesma `API_KEY` privada. O agente envia heartbeats pelo canal persistente e reconecta automaticamente quando a conexão cai.
- Use somente conteúdo que você tenha autorização para baixar.
