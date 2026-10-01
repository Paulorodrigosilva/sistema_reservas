# Publicar no Vercel

1. Crie um banco SQLite no Turso e gere um token de acesso.
2. Importe o repositório GitHub no Vercel.
3. Em **Settings > Environment Variables**, adicione estas variáveis para Production:

   - `TURSO_DATABASE_URL`: URL do banco Turso.
   - `TURSO_AUTH_TOKEN`: token de acesso do banco.
   - `SESSION_SECRET`: segredo aleatório com pelo menos 32 caracteres. Gere um com `openssl rand -hex 32`.
   - `MASTER_PASSWORD`: senha inicial do master, com pelo menos 12 caracteres.
   - `MASTER_EMAIL`: e-mail da conta master (opcional; padrão `master@empresa.com`).

4. Faça o deploy. O app cria as tabelas e a conta master na primeira inicialização.

O arquivo `database.sqlite` local é ignorado pelo Git e não é enviado ao Vercel. Para levar reservas existentes ao ambiente público, importe os dados locais para o banco Turso antes de usar o app.