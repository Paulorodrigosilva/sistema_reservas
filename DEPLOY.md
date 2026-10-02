# Publicar na Vercel (Sem Turso)

Este sistema agora utiliza **PostgreSQL padrão** para persistência na nuvem (compatível com **Supabase**, **Neon**, **Vercel Postgres**, **Railway** e **Render**), além de suporte automático a **SQLite local** quando nenhuma URL de banco for informada.

---

## 1. Opções de Banco de Dados para a Vercel

### Opção A: Neon ou Supabase na Vercel (Recomendado - 100% Gratuito)
1. No painel do seu projeto na Vercel, clique na aba **Storage**.
2. Clique em **Connect Store** e selecione **Neon** ou **Supabase**.
3. Siga o assistente de conexão rápida. A Vercel automaticamente preencherá a variável de ambiente `DATABASE_URL` (ou `POSTGRES_URL`) no seu projeto!
4. *(Se usar o Supabase diretamente)*: Copie a **URI de Conexão** (Connection String) em *Project Settings > Database > Connection string (URI)* e adicione como `DATABASE_URL`.

### Opção B: Teste Rápido sem nenhum banco externo
Se você fizer o deploy na Vercel sem preencher `DATABASE_URL`, o sistema inicia em modo SQLite temporário em `/tmp/database.sqlite`. É ótimo para testar a interface imediatamente antes de vincular um banco definitivo.

---

## 2. Variáveis de Ambiente na Vercel

No painel do seu projeto na Vercel, acesse **Settings > Environment Variables**:

| Variável | Descrição | Obrigatória na Vercel? |
|---|---|---|
| `DATABASE_URL` | URL de conexão PostgreSQL (`postgres://...` ou `postgresql://...`) | Sim (para persistir dados) |
| `SESSION_SECRET` | Chave aleatória para assinar as sessões (mínimo de 32 caracteres) | Recomendado |
| `MASTER_EMAIL` | E-mail do administrador (padrão: `master@empresa.com`) | Opcional |
| `MASTER_PASSWORD` | Senha inicial da conta master (padrão: `123`) | Recomendado |

---

## 3. Como Fazer o Deploy

1. Suba o repositório atualizado para o GitHub.
2. Na Vercel, clique em **Add New... > Project** e selecione o repositório.
3. Deixe o Framework Preset como **Other** (o arquivo `vercel.json` já configura as rotas e funções serverless).
4. Adicione suas variáveis de ambiente e clique em **Deploy**.
5. No primeiro acesso, o sistema criará automaticamente as tabelas e o usuário administrador.
6. Acesse `https://seu-app.vercel.app/api/health` para confirmar o status da conexão do banco.