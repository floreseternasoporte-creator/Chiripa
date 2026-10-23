# Chiripa

App de dinero de práctica estilo billetera: saldo, tarjeta virtual,
metas de ahorro, envíos y solicitudes entre usuarios con su $usuario.

- **En vivo:** https://floreseternasoporte-creator.github.io/Chiripa/
- **Frontend:** `index.html` (una sola página) + `aws-sdk-v3.bundle.js` +
  `chiripa-cloud.js` (adaptador de Amazon).
- **Backend:** Amazon DynamoDB (`chiripa-kv`) + Cognito Identity Pool —
  registros de usuarios, cuentas, $tags y transferencias sincronizados
  en tiempo real (~3 s). Ver `backend/README.md` y `backend/setup-aws.sh`.

Sin el `identityPoolId` configurado, la app corre en modo local
(localStorage), igual que la versión original.
