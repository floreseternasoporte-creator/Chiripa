/* ChiripaCloud — backend de Amazon para Chiripa (cuenta Vega Platforms).
 *
 * Cuenta única de Vega Platforms: Chiripa entra con la MISMA cuenta de
 * Drex (Cognito User Pool de Drex). Al iniciar sesión, el Identity Pool
 * `vega-platforms` entrega credenciales AWS y los datos de Chiripa se
 * guardan en DynamoDB `chiripa-kv` bajo el sub de la cuenta Vega.
 * Sin sesión Vega, la app funciona solo en local (localStorage).
 *
 * Interfaz de datos (la misma que ya usa la app):
 *   ChiripaCloud.db.doc(path).get() / .set() / .update() / .delete() / .acquire()
 *   ChiripaCloud.db.collection(name).onSnapshot(cb, err)
 *   ChiripaCloud.db.collection(name).where(field,'==',value).onSnapshot(cb, err)
 *   ChiripaCloud.user.id() / .me() / .can('data.write')
 *   ChiripaCloud.vega.signIn(email, pw) / .completeTotp(code) / .signOut() / .session()
 *
 * DynamoDB emula un árbol de documentos: pk = primer segmento de la
 * ruta, sk = resto unido con "/", atributo "v" = documento en JSON.
 * Tiempo real por sondeo cada `pollMs` con cálculo de docChanges.
 * Los ids de pools NO son secretos: son identificadores públicos.
 */
(function (global) {
  'use strict';

  var CHIRIPA_AWS_CONFIG = {
    region: 'us-east-1',
    identityPoolId: 'us-east-1:958300b9-c94b-4b82-8d89-1b5972b85685',
    userPoolId: 'us-east-1_kDSYEBsnY',
    userPoolClientId: '7cm12q14tm12u8b3bnn6ksjqni',
    tableName: 'chiripa-kv',
    pollMs: 3000
  };
  var LOGIN_PROVIDER = 'cognito-idp.' + CHIRIPA_AWS_CONFIG.region + '.amazonaws.com/' + CHIRIPA_AWS_CONFIG.userPoolId;

  function configured() {
    return !!(CHIRIPA_AWS_CONFIG.identityPoolId &&
      CHIRIPA_AWS_CONFIG.identityPoolId.indexOf(':') > 0 &&
      global.DrexAwsV3);
  }
  function vegaConfigured() {
    return !!(configured() && global.AmazonCognitoIdentity);
  }

  /* ---------- cuenta Vega Platforms (Cognito User Pool de Drex) ---------- */
  var _pool = null;
  var _session = null;
  var _pendingTotp = null;
  function userPool() {
    if (_pool) return _pool;
    _pool = new global.AmazonCognitoIdentity.CognitoUserPool({
      UserPoolId: CHIRIPA_AWS_CONFIG.userPoolId,
      ClientId: CHIRIPA_AWS_CONFIG.userPoolClientId
    });
    return _pool;
  }
  function sessionInfo(session) {
    var idToken = session.getIdToken();
    var payload = idToken.decodePayload();
    return {
      sub: payload.sub,
      email: payload.email || '',
      name: payload.name || payload.preferred_username || '',
      username: payload['cognito:username'] || '',
      idToken: idToken.getJwtToken()
    };
  }
  function vegaSession() {
    if (_session) return Promise.resolve(_session);
    if (!vegaConfigured()) return Promise.resolve(null);
    var user = userPool().getCurrentUser();
    if (!user) return Promise.resolve(null);
    return new Promise(function (resolve) {
      user.getSession(function (err, session) {
        if (err || !session || !session.isValid()) { resolve(null); return; }
        _session = sessionInfo(session);
        resolve(_session);
      });
    });
  }
  function vegaSignIn(email, password) {
    if (!vegaConfigured()) return Promise.reject(new Error('La cuenta Vega Platforms aún no está configurada en Chiripa.'));
    var C = global.AmazonCognitoIdentity;
    var clean = String(email || '').trim();
    function attempt(username) {
      var cognitoUser = new C.CognitoUser({ Username: username, Pool: userPool() });
      var authDetails = new C.AuthenticationDetails({ Username: username, Password: String(password || '') });
      return new Promise(function (resolve, reject) {
        cognitoUser.authenticateUser(authDetails, {
          onSuccess: function (session) {
            _session = sessionInfo(session);
            _credProvider = null; _credToken = null; _doc = null;
            resolve(_session);
          },
          onFailure: function (err) { reject(err); },
          totpRequired: function () {
            var e = new Error('Escribe el código de tu app de autenticación.');
            e.code = 'vega/totp-required';
            _pendingTotp = { user: cognitoUser, resolve: resolve, reject: reject };
            reject(e);
          },
          mfaRequired: function () {
            var e = new Error('Escribe el código que te enviamos.');
            e.code = 'vega/totp-required';
            _pendingTotp = { user: cognitoUser, resolve: resolve, reject: reject };
            reject(e);
          },
          newPasswordRequired: function () {
            var e = new Error('Tu cuenta Vega Platforms necesita una contraseña nueva. Cámbiala en Drex y vuelve a entrar.');
            e.code = 'vega/new-password-required';
            reject(e);
          }
        });
      });
    }
    return attempt(clean).catch(function (err) {
      var lower = clean.toLowerCase();
      var wrong = err && (err.code === 'NotAuthorizedException' || err.code === 'UserNotFoundException');
      if (wrong && lower !== clean) return attempt(lower);
      throw err;
    });
  }
  function vegaCompleteTotp(code) {
    if (!_pendingTotp) return Promise.reject(new Error('No hay un inicio de sesión esperando código.'));
    var pending = _pendingTotp;
    _pendingTotp = null;
    return new Promise(function (resolve, reject) {
      pending.user.sendMFACode(String(code || '').trim(), {
        onSuccess: function (session) {
          _session = sessionInfo(session);
          _credProvider = null; _credToken = null; _doc = null;
          resolve(_session);
        },
        onFailure: function (err) { reject(err); }
      }, 'SOFTWARE_TOKEN_MFA');
    });
  }
  function vegaSignOut() {
    var user = vegaConfigured() ? userPool().getCurrentUser() : null;
    if (user) user.signOut();
    _session = null;
    _credProvider = null; _credToken = null; _doc = null;
  }

  /* ---------- credenciales AWS (Identity Pool con la sesión Vega) ---------- */
  var _credProvider = null;
  var _credToken = null;
  function credProvider() {
    return vegaSession().then(function (session) {
      if (!session) throw new Error('Sin sesión Vega Platforms');
      if (_credProvider && _credToken === session.idToken) return _credProvider;
      var logins = {};
      logins[LOGIN_PROVIDER] = session.idToken;
      _credProvider = global.DrexAwsV3.fromCognitoIdentityPool({
        identityPoolId: CHIRIPA_AWS_CONFIG.identityPoolId,
        logins: logins,
        clientConfig: { region: CHIRIPA_AWS_CONFIG.region }
      });
      _credToken = session.idToken;
      _doc = null;
      return _credProvider;
    });
  }

  /* ---------- cliente DynamoDB (documentos) ---------- */
  var _doc = null;
  function docClient() {
    return credProvider().then(function (provider) {
      if (_doc) return _doc;
      var V3 = global.DrexAwsV3;
      var low = new V3.DynamoDBClient({
        region: CHIRIPA_AWS_CONFIG.region,
        credentials: provider
      });
      _doc = V3.DynamoDBDocumentClient.from(low);
      return _doc;
    });
  }
  function send(cmd) { return docClient().then(function (doc) { return doc.send(cmd); }); }
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
          var first = !tick._seen;
          tick._seen = true;
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
    id: function () {
      return vegaSession().then(function (session) {
        if (!session) throw new Error('Sin sesión Vega Platforms');
        return session.sub;
      });
    },
    me: function () {
      return vegaSession().then(function (session) {
        return session ? { sub: session.sub, email: session.email, name: session.name, username: session.username } : {};
      });
    },
    can: function () {
      return vegaSession().then(function (session) { return !!session; }).catch(function () { return false; });
    }
  };

  global.ChiripaCloud = {
    config: CHIRIPA_AWS_CONFIG,
    configured: configured(),
    db: configured() ? db : null,
    user: configured() ? user : null,
    vega: {
      configured: vegaConfigured(),
      signIn: vegaSignIn,
      completeTotp: vegaCompleteTotp,
      signOut: vegaSignOut,
      session: vegaSession
    }
  };
})(typeof window !== 'undefined' ? window : this);
