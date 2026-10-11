# Gerador de mundos Minecraft Bedrock (GitHub Actions)

Gera um mundo de Minecraft Bedrock **com chunks já pré-geradas**, usando o servidor oficial (BDS) dentro do GitHub Actions, e entrega o resultado como um arquivo `.mcworld` numa Release. Você baixa no celular e abre no jogo.

Projeto não oficial. Não é afiliado à Mojang nem à Microsoft. Ao usar, você aceita os termos da Mojang para o Bedrock Dedicated Server: https://minecraft.net/eula

## Como funciona

1. Você escolhe seed, regras do mundo e o raio de pré-geração.
2. O workflow baixa o BDS, configura o mundo e instala o addon de pré-geração da pasta `addon/`.
3. O servidor sobe e o workflow manda o comando de início para o addon (`scriptevent`).
4. O addon gera as chunks e avisa no log quando termina.
5. O workflow desliga o servidor (salvando o mundo), cria o `.mcworld` e publica numa Release.
6. As **notas da release listam tudo o que foi editado no mundo** (veja mais abaixo).

O addon também vai dentro do mundo. Ao abrir no jogo, ele pode continuar gerando o resto aos poucos.

## Estrutura do repositório

```
.github/workflows/gerar-mundo.yml   o workflow
addon/behavior_pack/manifest.json   addon de pré-geração (obrigatório)
addon/resource_pack/manifest.json   resource pack (opcional)
```

O `manifest.json` precisa ser JSON puro (sem comentários) e ter `version` no formato `[x, y, z]`.

## Como usar

### Opção 1: rodar manualmente

1. Vá em **Actions > Gerar mundo Bedrock > Run workflow**.
2. Preencha os campos e marque `accept_eula`.
3. Quando terminar, abra a **Release** criada e baixe o `.mcworld`.

### Opção 2: abrir uma issue

Crie uma issue com a label `gerar-mundo` e um bloco JSON no corpo:

````
```json
{
  "accept_eula": true,
  "world_name": "MeuMundo",
  "seed": "12345",
  "bds_version": "1.21.124.2",
  "gamemode": "survival",
  "difficulty": "normal",
  "allow_cheats": true,
  "level_type": "DEFAULT",
  "radius_chunks": 50,
  "center_x": 0,
  "center_z": 0,
  "max_minutes": 240,
  "gamerules": { "keepinventory": true, "doinsomnia": false }
}
```
````

O workflow comenta na issue com o link da release e fecha a issue.

Link de issue pré-preenchido (útil para um site estático):

```
https://github.com/USUARIO/REPO/issues/new?labels=gerar-mundo&title=Gerar+mundo&body=<JSON em URL-encode dentro de um bloco ```json>
```

Só **OWNER, MEMBER e COLLABORATOR** disparam por issue. Para liberar para qualquer pessoa, remova a checagem de `author_association` no `if:` do job (isso gasta os seus minutos de Actions).

## Configurações

| Campo | Padrão | Descrição |
|---|---|---|
| `accept_eula` | `false` | Obrigatório. Confirma que você aceita os termos da Mojang. |
| `world_name` | `Mundo` | Letras, números, espaço, `_` e `-` (até 32 caracteres). |
| `seed` | vazio | Vazio gera uma seed aleatória. Até 40 caracteres. |
| `bds_version` | `latest` | Ex.: `1.21.124.2`. **Use a mesma versão do seu Minecraft.** |
| `gamemode` | `survival` | `survival`, `creative` ou `adventure`. |
| `difficulty` | `normal` | `peaceful`, `easy`, `normal` ou `hard`. |
| `allow_cheats` | `true` | Liga os comandos no mundo. |
| `level_type` | `DEFAULT` | `DEFAULT`, `FLAT` ou `LEGACY`. |
| `radius_chunks` | `50` | Raio da pré-geração, de 1 a 100 (quadrado de `2r+1` chunks de lado). |
| `center_x`, `center_z` | `0` | Centro da pré-geração, em blocos. |
| `max_minutes` | `240` | Tempo máximo da pré-geração, de 10 a 330. |
| `gamerules` | `{}` | Objeto JSON, ex.: `{"keepinventory": true}`. Até 30 regras. |

## Contrato com o addon

O servidor roda **sem jogador**. O workflow conversa com o addon pelo console:

| Direção | Mensagem |
|---|---|
| Workflow para o addon | `scriptevent pregen:start <raio_em_chunks> <centro_x_em_blocos> <centro_z_em_blocos>` |
| Workflow para o addon | `scriptevent pregen:stop` (parar sem corromper nada) |
| Addon para o workflow | `console.warn("[PREGEN] START ...")` em até **2 minutos** após o start (confirmação) |
| Addon para o workflow | `console.warn("[PREGEN] PROGRESS 120/10000")` (opcional, aparece no log do Actions) |
| Addon para o workflow | `console.warn("[PREGEN] DONE")` ao terminar |

Se o addon não escrever nenhuma linha `[PREGEN]` em 2 minutos, o workflow falha cedo, em vez de esperar até o tempo máximo.

## O que aparece nas notas da release

Cada release descreve o que foi editado no mundo:

- **Configurações do mundo**: tabela com cada propriedade do `server.properties` alterada (antes e depois).
- **Gamerules**: cada regra aplicada, indicando se o log do servidor confirmou.
- **Packs adicionados**: nome, versão, UUID e pasta de cada pack instalado.
- **Pré-geração**: raio, quantidade de chunks, centro, área coberta (X e Z), tempo gasto e o último progresso do addon.
- **Servidor e arquivo**: versão do BDS, tamanho e SHA-256 do `.mcworld`.

Se o tempo máximo acabar antes do addon terminar, a release avisa que a pré-geração está **incompleta**.

## Importando no celular

Baixe o `.mcworld` da release e abra o arquivo. O Minecraft importa o mundo sozinho. A versão do jogo precisa ser igual ou mais nova que a do BDS usado.

## Limites e cuidados

- Cada job do Actions tem no máximo 6 horas. O workflow usa um teto de 350 minutos.
- Arquivos de release têm limite de 2 GB. O workflow falha se o `.mcworld` passar disso.
- O site do minecraft.net pode bloquear o download a partir do runner (erro 403). Se acontecer, informe `bds_version` explicitamente.
- Mundos gerados numa versão mais nova do BDS não abrem em clientes mais antigos.
- Se o seu addon usar APIs beta, o experimento correspondente precisa estar ligado no `level.dat`. O workflow ainda não faz esse ajuste.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `Defina accept_eula como true` | Faltou aceitar os termos. |
| `Não consegui descobrir a versão mais recente` | O site bloqueou o runner. Informe `bds_version`. |
| `Falha ao baixar ...` | Versão inexistente ou bloqueio (403). |
| `O addon não respondeu em 2 minutos` | O addon não trata o `scriptevent` sem jogador, ou não escreve `[PREGEN]` com `console.warn`. |
| `O servidor encerrou ...` | Erro no addon ou no manifest. Veja o fim do `server.log` no log do job. |
| Mundo importado vazio ou incompleto | A pré-geração estourou o tempo. Veja o aviso nas notas da release. |
