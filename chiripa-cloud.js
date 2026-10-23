/* ChiripaCloud — backend de Amazon para Chiripa.
 *
 * Reemplaza la capa de datos del entorno anterior (claude.use('db') /
 * claude.use('user')) por servicios de Amazon, exponiendo EXACTAMENTE la
 * misma interfaz que la app ya usa:
 *   ChiripaCloud.db.doc(path).get() / .set() / .update() / .delete() / .acquire()
 *   ChiripaCloud.db.collection(name).onSnapshot(cb, err)
 *   ChiripaCloud.db.collection(name).where(field,'==',value).onSnapshot(cb, err)
 *   ChiripaCloud.db.collection(name).doc().set(obj)
 *   ChiripaCloud.user.id() / .me() / .can('data.write')
 *
 * Motor de datos: DynamoDB, tabla `chiripa-kv` (región us-east-1).
 * La tabla emula un árbol de documentos, igual que en Drex:
 *   pk = primer segmento de la ruta, sk = resto unido con "/",
 *   atributo "v" = el documento serializado en JSON.
 *   Ej: doc('data/users/<id>/state') -> pk='data', sk='users/<id>/state'
 *       doc('accounts/<id>')        -> pk='accounts', sk='<id>'
 *       doc('tags/<tag>')           -> pk='tags', sk='<tag>'
 *       collection('transfers')     -> pk='transfers', sk='<id de la transferencia>'
 *
 * Identidad: Amazon Cognito Identity Pool. Cada navegador/dispositivo
 * recibe una identidad persistente de Cognito; ese id es el UID del
 * usuario dentro de Chiripa (sus registros, su estado y sus
 * transferencias se guardan bajo ese id en DynamoDB).
 *
 * Tiempo real: DynamoDB no empuja cambios al navegador, así que
 * onSnapshot sondea la tabla cada `pollMs` y emite los cambios
 * (added / modified / removed) calculando la diferencia, igual que
 * hacía el listener anterior. En la práctica una transferencia le
 * llega al otro usuario en ~3 segundos.
 *
 * Si `identityPoolId` está vacío, ChiripaCloud.db es null y la app
 * funciona solo en local (localStorage), exactamente como antes.
 * El id NO es un secreto: es un identificador público del pool.
 */
(function (global) {
  'use strict';

  var CHIRIPA_AWS_CONFIG = {
    region: 'us-east-1',
    identityPoolId: '', // <-- se rellena tras ejecutar backend/setup-aws.sh
    tableName: 'chiripa-kv',
    pollMs: 3000
  };

  function configured() {
    return !!(CHIRIPA_AWS_CONFIG.identityPoolId &&
      CHIRIPA_AWS_CONFIG.identityPoolId.indexOf(':') > 0 &&
      global.DrexAwsV3);
  }

  /* ---------- credenciales e identidad (Cognito Identity Pool) ---------- */
  var _credProvider = null;
  var _identityPromise = null;
  function credProvider() {
    if (_credProvider) return _credProvider;
    var V3 = global.DrexAwsV3;
    _credProvider = V3.fromCognitoIdentityPool({
      identityPoolId: CHIRIPA_AWS_CONFIG.identityPoolId,
      clientConfig: { region: CHIRIPA_AWS_CONFIG.region }
    });
    return _credProvider;
  }
  function identityId() {
    if (_identityPromise) return _identityPromise;
    _identityPromise = Promise.resolve()
      .then(function () { return credProvider()(); })
      .then(function (creds) {
        if (!creds || !creds.identityId) throw new Error('Cognito no devolvió identidad');
        return creds.identityId;
      })
      .catch(function (e) { _identityPromise = null; throw e; });
    return _identityPromise;
  }

  /* ---------- cliente DynamoDB (documentos) ---------- */
  var _doc = null;
  function docClient() {
    if (_doc) return _doc;
    var V3 = global.DrexAwsV3;
    var low = new V3.DynamoDBClient({
      region: CHIRIPA_AWS_CONFIG.region,
      credentials: credProvider()
    });
    _doc = V3.DynamoDBDocumentClient.from(low);
    return _doc;
  }
  function send(cmd) { return docClient().send(cmd); }
  function V3() { return global.DrexAwsV3; }

  /* ---------- rutas -> claves ---------- */
  function splitPath(path) {
    path = String(path || '').replace(/^\/+|\/+$/g, '');
    var i = path.indexOf('/');
    if (i < 0) return { pk: path, sk: '' };
    return { pk: path.slice(0, i), sk: path.slice(i + 1) };
  }
  function parseV(item) {
    if (!item || typeof item.v !== 'string') return undefined;
    try { return JSON.parse(item.v); } catch (e) { return undefined; }
  }

  /* ---------- referencias a documentos ---------- */
  function docRef(path) {
    var k = splitPath(path);
    return {
      id: k.sk.split('/').pop(),
      get: function () {
        return send(new (V3().GetCommand)({
          TableName: CHIRIPA_AWS_CONFIG.tableName, Key: { pk: k.pk, sk: k.sk }
        })).then(function (r) {
          var data = r && r.Item ? parseV(r.Item) : undefined;
          return {
            exists: data !== undefined,
            id: k.sk.split('/').pop(),
            data: function () { return data; }
          };
        });
      },
      set: function (obj) {
        return send(new (V3().PutCommand)({
          TableName: CHIRIPA_AWS_CONFIG.tableName,
          Item: { pk: k.pk, sk: k.sk, v: JSON.stringify(obj == null ? null : obj) }
        })).then(function () { return null; });
      },
      update: function (partial) {
        var self = this;
        return self.get().then(function (snap) {
          var base = snap.exists ? snap.data() : {};
          var merged = Object.assign({}, base, partial || {});
          return self.set(merged);
        });
      },
      delete: function () {
        return send(new (V3().DeleteCommand)({
          TableName: CHIRIPA_AWS_CONFIG.tableName, Key: { pk: k.pk, sk: k.sk }
        })).then(function () { return null; });
      },
      /* Reserva con expiración (para reclamar $tags sin duplicados):
       * escribe solo si el documento no existe, ya es del mismo
       * titular o la reserva anterior expiró. */
      acquire: function (opts) {
        opts = opts || {};
        var now = Date.now();
        var item = {
          pk: k.pk, sk: k.sk,
          v: JSON.stringify({ holder: opts.holder || '' }),
          _h: String(opts.holder || ''), _e: now + (opts.ttlMs || 4000)
        };
        return send(new (V3().PutCommand)({
          TableName: CHIRIPA_AWS_CONFIG.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk) OR #h = :h OR #e < :now',
          ExpressionAttributeNames: { '#h': '_h', '#e': '_e' },
          ExpressionAttributeValues: { ':h': item._h, ':now': now }
        })).then(function () { return { acquired: true }; })
          .catch(function (e) {
            if (e && e.name === 'ConditionalCheckFailedException') return { acquired: false };
            throw e;
          });
      }
    };
  }

  /* ---------- consultas / tiempo real por sondeo ---------- */
  function queryPartition(pk) {
    return send(new (V3().QueryCommand)({
      TableName: CHIRIPA_AWS_CONFIG.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk }
    })).then(function (r) {
      var out = new Map();
      (r && r.Items ? r.Items : []).forEach(function (item) {
        var data = parseV(item);
        if (data !== undefined) out.set(item.sk, data);
      });
      return out;
    });
  }
  function makeSnapshot(current, changes) {
    var docs = [];
    current.forEach(function (data, id) {
      docs.push({ id: id, data: function () { return data; } });
    });
    return {
      docs: docs,
      empty: docs.length === 0,
      size: docs.length,
      docChanges: function () { return changes; },
      forEach: function (fn) { docs.forEach(fn); }
    };
  }
  function diffMaps(prev, current) {
    var changes = [];
    current.forEach(function (data, id) {
      if (!prev.has(id)) {
        changes.push({ type: 'added', doc: { id: id, data: function () { return data; } } });
      } else if (JSON.stringify(prev.get(id)) !== JSON.stringify(data)) {
        changes.push({ type: 'modified', doc: { id: id, data: function () { return data; } } });
      }
    });
    prev.forEach(function (data, id) {
      if (!current.has(id)) {
        changes.push({ type: 'removed', doc: { id: id, data: function () { return data; } } });
      }
    });
    return changes;
  }
  function pollCollection(pk, filterFn, cb, errCb) {
    var prev = new Map();
    var stopped = false;
    var timer = null;
    function tick() {
      if (stopped) return;
      queryPartition(pk)
        .then(function (all) {
          if (stopped) return;
          var current = new Map();
          all.forEach(function (data, id) {
            if (!filterFn || filterFn(data, id)) current.set(id, data);
          });
          var changes = diffMaps(prev, current);
          var first = prev.size === 0 && current.size >= 0 && !tick._seen;
          tick._seen = true;
          /* La app ignora los avisos en la primera entrega (seenInit);
           * emitimos siempre el snapshot completo como cambios para que
           * su estado inicial se llene igual que con el listener anterior. */
          if (first) {
            changes = [];
            current.forEach(function (data, id) {
              changes.push({ type: 'added', doc: { id: id, data: function () { return data; } } });
            });
          }
          prev = current;
          try { cb(makeSnapshot(current, changes)); } catch (e) {}
          timer = setTimeout(tick, CHIRIPA_AWS_CONFIG.pollMs);
        })
        .catch(function (e) {
          if (errCb) { try { errCb(e); } catch (x) {} }
          timer = setTimeout(tick, CHIRIPA_AWS_CONFIG.pollMs * 2);
        });
    }
    tick();
    return function unsubscribe() {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  function collectionRef(name) {
    var pk = String(name || '');
    return {
      doc: function (id) {
        var docId = id || ('x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        return docRef(pk + '/' + docId);
      },
      where: function (field, op, value) {
        return {
          onSnapshot: function (cb, errCb) {
            if (op !== '==') throw new Error('ChiripaCloud solo soporta where ==');
            return pollCollection(pk, function (data) { return data && data[field] === value; }, cb, errCb);
          }
        };
      },
      onSnapshot: function (cb, errCb) {
        return pollCollection(pk, null, cb, errCb);
      }
    };
  }

  /* ---------- objetos públicos ---------- */
  var db = {
    doc: docRef,
    collection: collectionRef
  };
  var user = {
    id: function () { return identityId(); },
    me: function () { return Promise.resolve({}); },
    can: function () {
      return identityId().then(function () { return true; }).catch(function () { return false; });
    }
  };

  global.ChiripaCloud = {
    config: CHIRIPA_AWS_CONFIG,
    configured: configured(),
    db: configured() ? db : null,
    user: configured() ? user : null
  };
})(typeof window !== 'undefined' ? window : this);
