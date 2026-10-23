# Chiripa — backend de Amazon

Chiripa guarda todo en Amazon, en la misma cuenta y región (us-east-1)
que usa el resto de los proyectos, pero con recursos PROPIOS, separados
de Drex:

| Pieza | Servicio | Nombre |
|---|---|---|
| Registros de usuarios, estados de cuenta, directorio, $tags | DynamoDB | tabla `chiripa-kv` |
| Transferencias entre usuarios (envíos y solicitudes) | DynamoDB | partición `transfers` de `chiripa-kv` |
| Identidad de cada dispositivo/usuario | Cognito Identity Pool | pool `chiripa` |
| Permisos del navegador | IAM | rol `chiripa-unauth-role` (solo `chiripa-kv`, sin Scan) |

## Cómo funciona

La tabla emula un árbol de documentos: `pk` = primer segmento de la
ruta, `sk` = el resto, `v` = el documento en JSON.

- `data/users/<uid>/state` — estado completo de la cuenta (saldo derivado
  de sus movimientos, metas, bancos vinculados, tarjeta (sin número ni
  CVV), notificaciones, ajustes). El PIN, el KYC y los contactos NUNCA
  salen del teléfono: la app ya los excluía al sincronizar y se mantuvo.
- `accounts/<uid>` — directorio público mínimo: nombre y $tag, para que
  otros usuarios te encuentren.
- `tags/<tag>` — reserva del $usuario (con caducidad, sin duplicados).
- `transfers/<id>` — envíos y solicitudes entre usuarios.

**Tiempo real:** `chiripa-cloud.js` sondea DynamoDB cada 3 segundos y
emite los cambios (`added/modified/removed`) con la misma interfaz
`onSnapshot` que la app ya usaba; una transferencia aparece en el otro
teléfono en ~3 s, con su notificación.

**Identidad:** cada navegador obtiene una identidad persistente de
Cognito Identity Pool; ese id es el UID del usuario en Chiripa.

## Puesta en marcha (una vez)

1. En la consola de AWS de la cuenta, abrir **CloudShell** (us-east-1).
2. Subir `setup-aws.sh` a CloudShell y ejecutar `bash setup-aws.sh`.
3. Pegar el `identityPoolId` impreso en `chiripa-cloud.js`
   (`CHIRIPA_AWS_CONFIG.identityPoolId`) y hacer push del repo.

Sin ese paso, la app funciona solo en local (localStorage), como la
versión original.

## Límites honestos

- Es dinero de práctica: ningún movimiento toca bancos reales.
- El acceso del navegador a DynamoDB es a nivel de tabla (el rol no
  distingue filas por usuario). Es el mismo modelo con el que opera
  Drex hoy; el aislamiento fila-a-fila real exige mover las escrituras
  sensibles a una Lambda/AppSync con validación por identidad, que es
  el paso siguiente si Chiripa pasa de demo a producto.
