/* Veri katmanı: Supabase ile tüm konuşma burada yapılır. Arayüz yalnızca window.API'yi kullanır. */
(function () {
  'use strict';
  var C = window.APP_CONFIG || {};
  var configured = !!(C.supabaseUrl && C.supabaseKey && C.loginDomain &&
    !/PROJE-KODU|ANAHTAR|sirketiniz\.com/i.test(C.supabaseUrl + ' ' + C.supabaseKey + ' ' + C.loginDomain));
  var sb = null;

  function client() {
    return window.sbReady.then(function (lib) {
      if (!sb) sb = lib.createClient(C.supabaseUrl, C.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      return sb;
    });
  }
  function emailFor(username) {
    var u = String(username || '').trim().toLowerCase();
    return u.indexOf('@') > -1 ? u : u + '@' + String(C.loginDomain).trim().toLowerCase();
  }
  function friendly(e, fallback) {
    var m = String((e && e.message) || '').toLowerCase();
    if (/failed to fetch|networkerror|load failed/.test(m)) return new Error('Sunucuya bağlanılamadı. İnternet bağlantınızı kontrol edin.');
    if (/invalid login credentials/.test(m)) return new Error('Kullanıcı adı veya şifre hatalı');
    if (/email not confirmed/.test(m)) return new Error('Hesap henüz doğrulanmamış. Yöneticiye başvurun.');
    if (/rate limit|too many/.test(m)) return new Error('Çok fazla deneme. Biraz bekleyip tekrar deneyin.');
    if (/jwt|not authenticated|oturum/.test(m)) return new Error('Oturum süresi doldu, yeniden giriş yapın.');
    if (/çalışma yeri adı gerekli/.test(m)) return new Error('Çalışma yeri adını yazın');
    return new Error(fallback || 'Bir hata oluştu, tekrar deneyin');
  }
  function fetchAll(make) { // PostgREST sayfa sınırı (1000) için sayfalama
    var size = 1000, out = [];
    function page(from) {
      return make().range(from, from + size - 1).then(function (r) {
        if (r.error) throw r.error;
        out = out.concat(r.data || []);
        return r.data && r.data.length === size ? page(from + size) : out;
      });
    }
    return page(0);
  }
  function toUser(p, a) {
    return {
      id: p.id, name: p.name, username: p.username, role: p.role, createdAt: p.created_at,
      ack: a ? { workplace: a.workplace, version: a.version, at: a.agreed_at } : null
    };
  }

  window.API = {
    configured: configured,
    emailFor: emailFor,

    getSession: function () {
      return client().then(function (c) { return c.auth.getSession(); }).then(function (r) { return r.data && r.data.session; });
    },
    login: function (username, password) {
      return client().then(function (c) { return c.auth.signInWithPassword({ email: emailFor(username), password: password }); })
        .then(function (r) { if (r.error) throw friendly(r.error); return r.data.session; });
    },
    logout: function () {
      return client().then(function (c) { return c.auth.signOut(); }).catch(function () {});
    },
    me: function () { // oturumdaki kullanıcının profili ve son onayı
      return client().then(function (c) {
        return c.auth.getSession().then(function (s) {
          var uid = s.data && s.data.session && s.data.session.user.id;
          if (!uid) return null;
          return Promise.all([
            c.from('profiles').select('id,name,username,role,created_at').eq('id', uid).maybeSingle(),
            c.from('latest_ack').select('workplace,version,agreed_at').eq('user_id', uid).maybeSingle()
          ]).then(function (r) {
            if (r[0].error) throw friendly(r[0].error, 'Profil okunamadı. supabase/schema.sql çalıştırıldı mı?');
            if (!r[0].data) return null;
            return toUser(r[0].data, r[1].data);
          });
        });
      });
    },
    acknowledge: function (workplace, version) {
      return client().then(function (c) { return c.rpc('acknowledge', { p_workplace: workplace, p_version: version }); })
        .then(function (r) { if (r.error) throw friendly(r.error, 'Onay kaydedilemedi, tekrar deneyin'); });
    },
    changePassword: function (username, current, next) {
      return client().then(function (c) {
        return c.auth.signInWithPassword({ email: emailFor(username), password: current }).then(function (r) {
          if (r.error) throw new Error('Mevcut şifre hatalı');
          if (String(next || '').length < 8) throw new Error('Yeni şifre en az 8 karakter olmalı');
          return c.auth.updateUser({ password: next });
        }).then(function (r) { if (r.error) throw friendly(r.error, 'Şifre değiştirilemedi'); });
      });
    },

    /* ----- yönetici ----- */
    listEmployees: function () {
      return client().then(function (c) {
        return Promise.all([
          fetchAll(function () { return c.from('profiles').select('id,name,username,role,created_at').order('name'); }),
          fetchAll(function () { return c.from('latest_ack').select('user_id,workplace,version,agreed_at').order('user_id'); })
        ]);
      }).then(function (r) {
        var byUser = {}; r[1].forEach(function (a) { byUser[a.user_id] = a; });
        return r[0].map(function (p) { return toUser(p, byUser[p.id]); });
      }).catch(function (e) { throw friendly(e, 'Liste okunamadı'); });
    },
    history: function () {
      return client().then(function (c) {
        return fetchAll(function () { return c.from('acknowledgements').select('id,user_id,workplace,version,agreed_at').order('agreed_at', { ascending: false }).order('id', { ascending: false }); });
      }).catch(function (e) { throw friendly(e, 'Onay geçmişi okunamadı'); });
    },
    admin: function (action, payload) {
      var body = Object.assign({ action: action }, payload || {});
      return client().then(function (c) { return c.functions.invoke('admin-users', { body: body }); }).then(function (r) {
        if (!r.error) return r.data;
        var ctx = r.error.context;
        if (ctx && typeof ctx.json === 'function') {
          return ctx.json().then(function (j) { throw new Error((j && j.error) || 'İşlem başarısız'); }, function () { throw new Error('İşlem başarısız'); });
        }
        if (/not found|404/i.test(String(r.error.message))) throw new Error('admin-users fonksiyonu bulunamadı. README 5. adımı uygulayın.');
        throw friendly(r.error, 'İşlem başarısız');
      });
    }
  };
})();
