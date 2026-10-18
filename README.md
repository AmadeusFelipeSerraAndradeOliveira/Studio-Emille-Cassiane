# Studio Emille Cassiane

Site responsivo e painel administrativo para catálogo, pedidos de horário e manutenção de dados. O frontend usa HTML, CSS e JavaScript modular; Auth, Firestore e Hosting são os únicos serviços Firebase necessários. A arquitetura não usa servidor próprio, Cloud Functions, Storage, tarefas agendadas ou uma conta de faturamento.

> A aplicação está pronta para configurar e testar. Ainda não está pronta para receber clientes: faltam o projeto Firebase, UIDs autorizados, dados reais de contato, catálogo e expediente. Não publique como produção antes de concluir a lista de testes deste documento.

## O que está implementado

- Página pública responsiva com apresentação, catálogo de serviços ativos, valores, ofertas, contato, aviso de privacidade e pedido de horário.
- Login administrativo por Firebase Authentication. O painel e as regras verificam UIDs autorizados; qualquer usuário autenticado não vira administrador.
- Cadastro, edição, ativação, ocultação e exclusão de serviços; duração; preço normal e período promocional.
- Expediente, dias atendidos, intervalo, feriados/folgas, antecedência mínima e limite de dias para agendar.
- Reservas pendentes com preço e duração registrados, criação e vencimento em 30 minutos. Os bloqueios abrangem todos os blocos ocupados de 30 minutos e são escritos com o pedido em uma transação Firestore. As regras repetem a validação do preço, serviço, horário, UID e transação atômica.
- Aprovação, recusa, cancelamento, liberação dos bloqueios e mensagem pré-preenchida para WhatsApp. A mensagem diz que o pedido estava pendente até aprovação.
- Agenda por dia, semana ou mês; filtros por status; pesquisa por nome/telefone; paginação de 100 pedidos.
- Exportação CSV compatível com Excel e impressão do navegador para PDF.
- Rotina de retenção de 60 dias, desativada por padrão. Ao abrir o painel, são consultados lotes de até 100 pedidos recusados, expirados ou cancelados. Cada lote precisa ser exportado e confirmado antes da exclusão. Pedidos pendentes, confirmados e futuros são preservados.
- Regras Firestore de menor privilégio e índices exigidos. A disponibilidade pública lê bloqueios por chave e não pode listar pedidos nem consultar dados de clientes.
- O documento público de expediente fica separado do documento administrativo de retenção; IDs internos da última exportação não são expostos aos visitantes.
- Modo de demonstração: abra `index.html?demo=1`. Ele usa dados ilustrativos apenas em memória e **não** grava reservas nem abre WhatsApp.

## Limites conhecidos

1. **Aprovação humana e limite de expiração:** o bloqueio pendente passa a ser elegível para reutilização após 30 minutos, usando o horário do servidor nas regras. O documento antigo pode continuar com status `pending` até alguém abrir o painel. Ao abrir o painel, uma rotina administrativa o marca como expirado e remove os bloqueios que ainda pertençam a ele.
2. **Retenção:** Spark não agenda exclusões em horário fixo. A verificação ocorre quando um administrador abre o painel. O sistema não apaga sozinho: o administrador exporta e confirma cada lote. Os estados `confirmed` são preservados porque podem ter relevância operacional ou legal.
3. **Agendamento e concorrência:** o Firestore Standard executa a transação e as regras garantem um vencedor para horários concorrentes e impedem sobreposição em blocos de 30 minutos. Transações exigem conexão; em modo offline o pedido falha com orientação para tentar novamente. Regras bloqueiam dados manipulados, mas não impedem que um visitante automatizado faça spam com pedidos em horários diferentes. Configure App Check e monitore o uso antes de exigir tokens; não há limite por IP/telefone sem um serviço confiável adicional.
4. **Fuso horário:** a interface usa `America/Araguaina`, UTC−03:00. O arquivo `firestore.rules` também valida esse deslocamento. Se o studio operar em outro fuso, altere `CONFIG.timezone` e a constante `duration.value(3, 'h')` nas regras, e rode novamente os testes.
5. **Rastreamento do cliente:** ao enviar, o cliente vê claramente que o pedido está pendente. Não existe busca pública posterior por telefone ou listagem pública de pedidos, para não expor dados pessoais. O studio confirma pelo WhatsApp.
6. **Cotas gratuitas:** as cotas dependem do projeto inteiro, podem mudar e não significam serviço ilimitado. A documentação Firebase informa, para Firestore Standard, 1 GiB armazenado, 50.000 leituras/dia, 20.000 escritas/dia e 20.000 exclusões/dia na base elegível; TTL automático, backups, restauração e PITR exigem faturamento. Firebase Hosting informa 10 GB de armazenamento e 10 GB/mês de transferência sem custo no nível documentado atualmente. Quando o limite sem custo é atingido, alguns recursos podem deixar de funcionar até a renovação ou mudança de plano. Confira os limites atuais no Console antes de publicar.
7. O domínio personalizado é contratado separadamente pelo proprietário. Nenhum faturamento, plano Blaze, Cloud Function ou recurso pago é ativado por este projeto.

## Configurar no VS Code e Firebase

1. Extraia o ZIP e abra a pasta `Studio-Emille-Cassiane` no VS Code. Use um servidor HTTP local ou o emulador Hosting; não abra os arquivos diretamente como `file://`, pois os módulos JavaScript são carregados por HTTP.
2. Crie um projeto Firebase no plano Spark e adicione um app Web. Habilite **Authentication → Sign-in method → E-mail/senha** e crie manualmente a conta inicial do studio. Não há senha padrão no código.
3. Copie os dados do app Web para `assets/config.js`: `apiKey`, `authDomain`, `projectId` e `appId`. Esses campos são identificadores públicos do app, não credenciais administrativas. Restrinja a chave de API ao domínio publicado depois de criar o domínio. **Não** coloque service account JSON, senha, token privado ou credenciais de servidor no navegador.
4. Abra Authentication, copie o UID do usuário inicial e substitua `__UID_ADMIN_1__` em `firestore.rules`. Substitua o segundo marcador por outro UID autorizado ou mantenha-o reservado. Copie os mesmos UIDs para `authorizedAdminUids` em `assets/config.js`. A lista no JavaScript controla a interface; as regras são a autoridade de segurança.
5. Preencha `whatsappE164` somente com dígitos, incluindo DDI e DDD; endereço e Instagram são opcionais. Revise `privacy.html` e substitua os campos entre colchetes antes de receber dados reais. Não invente um endereço ou contato.
6. Copie `.firebaserc.example` para `.firebaserc` e coloque o `projectId` real. Confirme que o projeto usa Firestore **Standard** e que essa é a única base elegível para a cota gratuita do projeto. A aplicação não cria nem altera bases existentes.
7. Instale as ferramentas locais com `npm install`. Teste a lógica local: `npm run test:core`. Para testar as regras no emulador: `npm run test:rules`. Os testes de regras usam o projeto fictício `demo-studio-emille`; não enviam dados ao Firebase real.
8. Para publicar, instale o Firebase CLI incluído em `devDependencies`, faça login no seu terminal do VS Code (`npx firebase-tools login`), selecione o projeto (`npx firebase-tools use --add`) e publique regras, índices e Hosting:

   ```powershell
   npx firebase-tools deploy --only firestore:rules,firestore:indexes,hosting
   ```

   O comando altera o projeto remoto selecionado. Confira o `projectId` mostrado pelo CLI antes de confirmar.
9. Faça login no painel em `/admin.html`. Salve o expediente real na aba **Expediente**, crie e revise serviços na aba **Serviços**, e só então ative serviços. Os valores iniciais do formulário de expediente são exemplos e não aparecem publicamente antes de serem salvos.
10. Teste o site publicado com um telefone próprio e um pedido que você possa aprovar e cancelar. Não use dados de clientes reais durante os testes. Confira o painel de uso do Firestore e Hosting. Para domínio próprio, associe o domínio na seção Hosting do Firebase Console e configure os registros DNS indicados; a compra do domínio é separada.

### App Check (recomendado, opcional)

O projeto permite configurar App Check com reCAPTCHA v3. Cadastre o domínio e o site key no serviço reCAPTCHA/Firebase, preencha `recaptchaV3SiteKey` em `assets/config.js`, monitore as métricas e só então ative a aplicação de App Check para Firestore no Console. Não imponha enforcement antes de validar o app e o domínio, pois pedidos legítimos podem ser rejeitados. App Check reduz abuso automatizado, mas não substitui regras nem impede todo spam.

## Testes e aceite

### Executados nesta entrega

- `npm run test:core`: 9 testes de datas e fuso, horário de expediente/intervalo, folgas, blocos sobrepostos, promoções, vencimento, retenção, telefone/WhatsApp e CSV.
- A suíte `tests/rules.test.mjs` foi preparada para testar acesso público/administrativo, campos de preço, pedidos concorrentes, substituição de bloqueio expirado e aprovação atômica. Execute `npm run test:rules` depois de instalar as dependências para validar no emulador.

### Ainda depende da sua configuração e teste manual

- Login real e bloqueio de UID não autorizado após preencher os UIDs e publicar as regras.
- Criar pedido no Firestore real, aprovar/recusar/cancelar e abrir WhatsApp com o número correto.
- Expiração após aguardar 30 minutos; reabertura do horário com cliente conectado e painel fechado.
- Exportar e excluir um lote no emulador ou em projeto de testes; confirmar preservação de pedidos futuros e pedidos confirmados.
- Erros reais de conexão, regras/índices implantados, App Check e aparência nos dispositivos que o studio usa.

O modo `?demo=1` serve para revisar o layout e o formulário; ele não substitui esses testes de Firebase. Não declare a aplicação pronta para produção até executar as verificações manuais acima.

## Estrutura

```text
index.html                 Site público
admin.html                 Login e painel administrativo
privacy.html               Aviso de privacidade modelo
assets/config.js           Dados personalizáveis e configuração Firebase pública
assets/firebase.js         Inicialização modular do SDK e modo emulador
assets/domain.js           Datas, disponibilidade, CSV e regras de domínio
assets/app.js              Catálogo e pedido público
assets/admin.js            Painel, exportação e retenção
firestore.rules            Acesso e validação Firestore
firestore.indexes.json     Índices compostos necessários
firebase.json              Firebase Hosting e Emulator Suite
tests/                     Testes de lógica e regras
```

## Referências Firebase

- [Planos Firebase Spark e Blaze](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)
- [Cotas e faturamento do Cloud Firestore](https://firebase.google.com/docs/firestore/pricing)
- [Cotas e preços do Firebase Hosting](https://firebase.google.com/docs/hosting/usage-quotas-pricing)
- [Transações e gravações em lote](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [Regras e validação de gravações atômicas](https://firebase.google.com/docs/firestore/security/rules-conditions)
- [Firebase App Check para web](https://firebase.google.com/docs/app-check/web/recaptcha-provider)

