# Studio Emille Cassiane

Site responsivo e painel administrativo para catálogo, pedidos de horário e manutenção de dados. O frontend usa HTML, CSS e JavaScript modular; Auth, Firestore e Hosting são os únicos serviços Firebase necessários. A arquitetura não usa servidor próprio, Cloud Functions, Storage, tarefas agendadas ou uma conta de faturamento.

> O código está configurado para o app Firebase informado. O proprietário informou que atualizou as regras do Firestore no Console. Antes de receber clientes, preencha os dados reais de contato, catálogo e expediente, aplique ou confira os índices e teste o fluxo real.

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

1. **Conexão e expiração:** o app está configurado para `studio-cassiana-emille`. O proprietário informou que atualizou as regras revisadas no Firebase Console; não foi possível confirmar a publicação pelo CLI neste ambiente. Confira também se os índices compostos deste projeto estão criados. O bloqueio pendente fica elegível para reutilização após 30 minutos, usando o horário do servidor; o pedido antigo só é marcado como expirado quando o painel for aberto.
2. **Retenção:** Spark não agenda exclusões em horário fixo. A verificação ocorre quando um administrador abre o painel. O sistema não apaga sozinho: o administrador exporta e confirma cada lote. Os estados `confirmed` são preservados porque podem ter relevância operacional ou legal.
3. **Agendamento e concorrência:** o Firestore Standard executa a transação e as regras garantem um vencedor para horários concorrentes e impedem sobreposição em blocos de 30 minutos. Transações exigem conexão; em modo offline o pedido falha com orientação para tentar novamente. Regras bloqueiam dados manipulados, mas não impedem que um visitante automatizado faça spam com pedidos em horários diferentes. Configure App Check e monitore o uso antes de exigir tokens; não há limite por IP/telefone sem um serviço confiável adicional.
4. **Fuso horário:** a interface usa `America/Araguaina`, UTC−03:00. O arquivo `firestore.rules` também valida esse deslocamento. Se o studio operar em outro fuso, altere `CONFIG.timezone` e a constante `duration.value(3, 'h')` nas regras, e rode novamente os testes.
5. **Rastreamento do cliente:** ao enviar, o cliente vê claramente que o pedido está pendente. Não existe busca pública posterior por telefone ou listagem pública de pedidos, para não expor dados pessoais. O studio confirma pelo WhatsApp.
6. **Cotas gratuitas:** as cotas dependem do projeto inteiro, podem mudar e não significam serviço ilimitado. A documentação Firebase informa, para Firestore Standard, 1 GiB armazenado, 50.000 leituras/dia, 20.000 escritas/dia e 20.000 exclusões/dia na base elegível; TTL automático, backups, restauração e PITR exigem faturamento. Firebase Hosting informa 10 GB de armazenamento e 10 GB/mês de transferência sem custo no nível documentado atualmente. Quando o limite sem custo é atingido, alguns recursos podem deixar de funcionar até a renovação ou mudança de plano. Confira os limites atuais no Console antes de publicar.
7. O domínio personalizado é contratado separadamente pelo proprietário. Nenhum faturamento, plano Blaze, Cloud Function ou recurso pago é ativado por este projeto.

## Configurar no VS Code e Firebase

1. Extraia o ZIP e abra a pasta `Studio-Emille-Cassiane` no VS Code. Use um servidor HTTP local ou o emulador Hosting; não abra os arquivos diretamente como `file://`, pois os módulos JavaScript são carregados por HTTP.
2. Confirme que `studio-cassiana-emille` está selecionado e que o app Web foi criado. No Firebase Console, habilite **Authentication → Sign-in method → E-mail/senha** se ainda não estiver ativo. O UID administrativo informado já está autorizado no código; não há senha no projeto.
3. Os dados do app Web já estão preenchidos em `assets/config.js` para `studio-cassiana-emille`. Esses campos identificam publicamente o app; não são credenciais administrativas. Restrinja a chave de API aos domínios do site antes de publicar. **Não** coloque service account JSON, senha, token privado ou credenciais de servidor no navegador.
4. O UID `4zC1SQs7YRQ0FfkGARdImqu2w7z1` está autorizado tanto na interface quanto nas regras Firestore. Se trocar a conta administrativa, atualize `authorizedAdminUids` em `assets/config.js` e a função `isAdmin()` em `firestore.rules` com o UID da nova conta.
5. Preencha `whatsappE164` somente com dígitos, incluindo DDI e DDD; endereço e Instagram são opcionais. Revise `privacy.html` e substitua os campos entre colchetes antes de receber dados reais. Não invente um endereço ou contato.
6. O `.firebaserc` local já aponta para `studio-cassiana-emille`; em outro computador, copie `.firebaserc.example` e substitua pelo ID correto. Confirme que o projeto usa Firestore **Standard** e que essa é a única base elegível para a cota gratuita do projeto. A aplicação não cria nem altera bases existentes.
7. Instale Java (necessário para o Firestore Emulator) e as ferramentas locais com `npm install`. Teste a lógica local: `npm run test:core`. Para testar as regras no emulador: `npm run test:rules`. Os testes de regras usam o projeto fictício `demo-studio-emille`; não enviam dados ao Firebase real.
   O site carrega Firebase JS SDK 13.0.0 do CDN. O pacote Node `firebase@12.19.0` fica reservado ao emulador porque `@firebase/rules-unit-testing` 5.x declara compatibilidade com a série 12.
8. Para publicar, instale o Firebase CLI incluído em `devDependencies`, faça login no seu terminal do VS Code (`npx firebase-tools login`), selecione o projeto (`npx firebase-tools use --add`) e publique regras, índices e Hosting:

   ```powershell
   npx firebase-tools deploy --only firestore:rules,firestore:indexes,hosting
   ```

   O comando altera regras e índices do projeto remoto selecionado. Confira o `projectId` mostrado pelo CLI antes de confirmar. No momento, o Firestore real ainda responde `PERMISSION_DENIED`, conforme a regra inicial `allow read, write: if false`; o site só carregará o catálogo depois de publicar as regras deste projeto.
9. Faça login no painel em `/admin.html`. Salve o expediente real na aba **Expediente**, crie e revise serviços na aba **Serviços**, e só então ative serviços. Os valores iniciais do formulário de expediente são exemplos e não aparecem publicamente antes de serem salvos.
10. Teste o site publicado com um telefone próprio e um pedido que você possa aprovar e cancelar. Não use dados de clientes reais durante os testes. Confira o painel de uso do Firestore e Hosting. Para domínio próprio, associe o domínio na seção Hosting do Firebase Console e configure os registros DNS indicados; a compra do domínio é separada.

### App Check (recomendado, opcional)

O projeto permite configurar App Check com reCAPTCHA v3. Cadastre o domínio e o site key no serviço reCAPTCHA/Firebase, preencha `recaptchaV3SiteKey` em `assets/config.js`, monitore as métricas e só então ative a aplicação de App Check para Firestore no Console. Não imponha enforcement antes de validar o app e o domínio, pois pedidos legítimos podem ser rejeitados. App Check reduz abuso automatizado, mas não substitui regras nem impede todo spam.

## Testes e aceite

### Executados nesta entrega

- `npm run test:core`: 10 testes de configuração Firebase, datas e fuso, horário de expediente/intervalo, folgas, blocos sobrepostos, promoções, vencimento, retenção, telefone/WhatsApp e CSV.
- `npm run test:rules`: 6 testes aprovados no emulador local, cobrindo acesso público/administrativo, preço adulterado, pedidos concorrentes, bloqueio expirado e aprovação atômica. Foi usado um JDK temporário; os testes usam o projeto fictício `demo-studio-emille` e não alteram dados reais.
- O proprietário informou que atualizou as regras no Firebase Console. A publicação não foi verificada pelo CLI neste ambiente; confirme os índices e teste login e gravações reais em condições controladas.

### Ainda depende da sua configuração e teste manual

- Login real e bloqueio de UID não autorizado após publicar as regras.
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
