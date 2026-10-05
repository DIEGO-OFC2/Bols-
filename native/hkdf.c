/* Native HKDF-SHA256 / SHA-256 / HMAC-SHA256 for lightwa.
 *
 * Self-contained: no OpenSSL link and no node-gyp. At load time it tries to
 * dlopen the system libcrypto for its SHA-NI accelerated SHA-256 (roughly 2.4x
 * the portable C core below); if libcrypto is missing it silently uses the
 * bundled C implementation. The JS (@noble/hashes) path remains the fallback
 * when this addon is not built at all. */
#include <node_api.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdbool.h>
#include <dlfcn.h>

/* ---------------- SHA-256 ---------------- */
typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t n; } sha256_ctx;

static const uint32_t K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2 };

#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))

static void sha256_block(sha256_ctx *c, const uint8_t *p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = ((uint32_t)p[i*4]<<24)|((uint32_t)p[i*4+1]<<16)|((uint32_t)p[i*4+2]<<8)|p[i*4+3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3);
    uint32_t s1 = ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10);
    w[i] = w[i-16]+s0+w[i-7]+s1;
  }
  uint32_t a=c->h[0],b=c->h[1],cc=c->h[2],d=c->h[3],e=c->h[4],f=c->h[5],g=c->h[6],h=c->h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = ROR(e,6)^ROR(e,11)^ROR(e,25);
    uint32_t ch = (e&f)^(~e&g);
    uint32_t t1 = h+S1+ch+K[i]+w[i];
    uint32_t S0 = ROR(a,2)^ROR(a,13)^ROR(a,22);
    uint32_t mj = (a&b)^(a&cc)^(b&cc);
    uint32_t t2 = S0+mj;
    h=g;g=f;f=e;e=d+t1;d=cc;cc=b;b=a;a=t1+t2;
  }
  c->h[0]+=a;c->h[1]+=b;c->h[2]+=cc;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;
}

static void sha256_init(sha256_ctx *c) {
  c->h[0]=0x6a09e667;c->h[1]=0xbb67ae85;c->h[2]=0x3c6ef372;c->h[3]=0xa54ff53a;
  c->h[4]=0x510e527f;c->h[5]=0x9b05688c;c->h[6]=0x1f83d9ab;c->h[7]=0x5be0cd19;
  c->len=0;c->n=0;
}
static void sha256_update(sha256_ctx *c, const uint8_t *p, size_t len) {
  c->len += len;
  while (len) {
    size_t take = 64 - c->n; if (take > len) take = len;
    memcpy(c->buf + c->n, p, take); c->n += take; p += take; len -= take;
    if (c->n == 64) { sha256_block(c, c->buf); c->n = 0; }
  }
}
static void sha256_final(sha256_ctx *c, uint8_t out[32]) {
  uint64_t bits = c->len * 8;
  c->buf[c->n++] = 0x80;
  if (c->n > 56) {
    memset(c->buf + c->n, 0, 64 - c->n);
    sha256_block(c, c->buf);
    c->n = 0;
  }
  memset(c->buf + c->n, 0, 56 - c->n);
  for (int i = 0; i < 8; i++) c->buf[56 + i] = (uint8_t)(bits >> (56 - i * 8));
  sha256_block(c, c->buf);
  for (int i=0;i<8;i++) { out[i*4]=c->h[i]>>24; out[i*4+1]=c->h[i]>>16; out[i*4+2]=c->h[i]>>8; out[i*4+3]=c->h[i]; }
}
static void sha256(const uint8_t *p, size_t len, uint8_t out[32]);

/* ---------------- Optional OpenSSL SHA-NI backend ---------------- */
/* SHA256_CTX layout is not part of a stable ABI; over-allocate. */
typedef struct { uint64_t opaque[32]; } sha256_ctx_ossl;
typedef int (*sha_init_fn)(sha256_ctx_ossl *);
typedef int (*sha_update_fn)(sha256_ctx_ossl *, const void *, size_t);
typedef int (*sha_final_fn)(unsigned char *, sha256_ctx_ossl *);

static sha_init_fn ossl_init = NULL;
static sha_update_fn ossl_update = NULL;
static sha_final_fn ossl_final = NULL;

__attribute__((constructor)) static void load_libcrypto(void) {
  const char *names[] = { "libcrypto.so.3", "libcrypto.so", "libcrypto.so.1.1", "libcrypto.dylib", NULL };
  void *h = NULL;
  for (int i = 0; names[i] && !h; i++) h = dlopen(names[i], RTLD_LAZY | RTLD_LOCAL);
  if (!h) return;
  ossl_init = (sha_init_fn)dlsym(h, "SHA256_Init");
  ossl_update = (sha_update_fn)dlsym(h, "SHA256_Update");
  ossl_final = (sha_final_fn)dlsym(h, "SHA256_Final");
  if (!ossl_init || !ossl_update || !ossl_final) { ossl_init = NULL; ossl_update = NULL; ossl_final = NULL; }
}

static void sha256(const uint8_t *p, size_t len, uint8_t out[32]) {
  if (ossl_init) {
    sha256_ctx_ossl c;
    ossl_init(&c); ossl_update(&c, p, len); ossl_final(out, &c);
    return;
  }
  sha256_ctx c; sha256_init(&c); sha256_update(&c,p,len); sha256_final(&c,out);
}

/* ---------------- HMAC-SHA256 ---------------- */
static void hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen, uint8_t out[32]) {
  uint8_t k[64]; memset(k,0,64);
  if (klen > 64) sha256(key, klen, k); else memcpy(k, key, klen);
  uint8_t ipad[64], opad[64];
  for (int i=0;i<64;i++){ ipad[i]=k[i]^0x36; opad[i]=k[i]^0x5c; }

  if (ossl_init) {
    sha256_ctx_ossl c, c2;
    uint8_t inner[32];
    ossl_init(&c); ossl_update(&c, ipad, 64); ossl_update(&c, msg, mlen); ossl_final(inner, &c);
    ossl_init(&c2); ossl_update(&c2, opad, 64); ossl_update(&c2, inner, 32); ossl_final(out, &c2);
    return;
  }
  sha256_ctx c; sha256_init(&c); sha256_update(&c,ipad,64); sha256_update(&c,msg,mlen);
  uint8_t inner[32]; sha256_final(&c,inner);
  sha256_init(&c); sha256_update(&c,opad,64); sha256_update(&c,inner,32); sha256_final(&c,out);
}

/* ---------------- HKDF-SHA256 (RFC 5869) ---------------- */
static void hkdf(const uint8_t *ikm, size_t ikml, const uint8_t *salt, size_t saltl,
                 const uint8_t *info, size_t infol, uint8_t *out, size_t outl) {
  uint8_t prk[32]; hmac_sha256(salt, saltl, ikm, ikml, prk);
  uint8_t t[32]; size_t tlen = 0, done = 0; uint8_t ctr = 1;

  if (ossl_init) {
    while (done < outl) {
      sha256_ctx_ossl c; uint8_t inner[32];
      ossl_init(&c);
      /* Precompute the padded PRK so the per-chunk rounds stay tight. */
      uint8_t k[64]; memset(k,0,64); memcpy(k,prk,32);
      uint8_t ipad[64]; for (int i=0;i<64;i++) ipad[i]=k[i]^0x36;
      ossl_update(&c, ipad, 64);
      if (tlen) ossl_update(&c, t, tlen);
      if (infol) ossl_update(&c, info, infol);
      ossl_update(&c, &ctr, 1);
      ossl_final(inner, &c);
      sha256_ctx_ossl c2; ossl_init(&c2);
      uint8_t opad[64]; for (int i=0;i<64;i++) opad[i]=k[i]^0x5c;
      ossl_update(&c2, opad, 64); ossl_update(&c2, inner, 32); ossl_final(t, &c2);
      tlen = 32;
      size_t take = outl - done; if (take > 32) take = 32;
      memcpy(out + done, t, take); done += take; ctr++;
    }
    return;
  }

  while (done < outl) {
    sha256_ctx hc;
    uint8_t k[64]; memset(k,0,64); memcpy(k,prk,32);
    uint8_t ipad[64],opad[64]; for(int i=0;i<64;i++){ipad[i]=k[i]^0x36;opad[i]=k[i]^0x5c;}
    sha256_init(&hc); sha256_update(&hc,ipad,64);
    if (tlen) sha256_update(&hc,t,tlen);
    if (infol) sha256_update(&hc,info,infol);
    sha256_update(&hc,&ctr,1);
    uint8_t inner[32]; sha256_final(&hc,inner);
    sha256_init(&hc); sha256_update(&hc,opad,64); sha256_update(&hc,inner,32); sha256_final(&hc,t);
    tlen = 32;
    size_t take = outl - done; if (take > 32) take = 32;
    memcpy(out + done, t, take); done += take; ctr++;
  }
}

/* ---------------- N-API glue ---------------- */
static bool as_buffer(napi_env env, napi_value v, uint8_t **data, size_t *len) {
  bool is; napi_is_buffer(env, v, &is);
  if (!is) return false;
  napi_get_buffer_info(env, v, (void**)data, len);
  return true;
}

static napi_value n_hkdf(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t *ikm,*salt,*inf; size_t ikml,saltl,infol;
  if (!as_buffer(env,argv[0],&ikm,&ikml) || !as_buffer(env,argv[1],&salt,&saltl) || !as_buffer(env,argv[2],&inf,&infol)) {
    napi_throw_type_error(env,NULL,"expected (Buffer ikm, Buffer salt, Buffer info, number len)"); return NULL;
  }
  uint32_t outl; napi_get_value_uint32(env, argv[3], &outl);
  if (outl > 8160) { napi_throw_range_error(env,NULL,"hkdf length exceeds 255*32"); return NULL; }
  void *out; napi_value res;
  napi_create_buffer(env, outl, &out, &res);
  hkdf(ikm,ikml,salt,saltl,inf,infol,(uint8_t*)out,outl);
  return res;
}

static napi_value n_sha256(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t *d; size_t l;
  if (!as_buffer(env,argv[0],&d,&l)) { napi_throw_type_error(env,NULL,"expected (Buffer)"); return NULL; }
  void *out; napi_value res; napi_create_buffer(env,32,&out,&res);
  sha256(d,l,(uint8_t*)out); return res;
}
static napi_value n_hmac(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2]; napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  uint8_t *k,*m; size_t kl,ml;
  if (!as_buffer(env,argv[0],&k,&kl) || !as_buffer(env,argv[1],&m,&ml)) { napi_throw_type_error(env,NULL,"expected (Buffer key, Buffer msg)"); return NULL; }
  void *out; napi_value res; napi_create_buffer(env,32,&out,&res);
  hmac_sha256(k,kl,m,ml,(uint8_t*)out); return res;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value f;
  napi_create_function(env,NULL,NAPI_AUTO_LENGTH,n_hkdf,NULL,&f); napi_set_named_property(env,exports,"hkdf",f);
  napi_create_function(env,NULL,NAPI_AUTO_LENGTH,n_sha256,NULL,&f); napi_set_named_property(env,exports,"sha256",f);
  napi_create_function(env,NULL,NAPI_AUTO_LENGTH,n_hmac,NULL,&f); napi_set_named_property(env,exports,"hmacSha256",f);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
