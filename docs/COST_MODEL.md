# Maliyet Modeli ve Beklenen Tasarruf

Bu doküman iki şeyi hesaplar: gateway'in kendi altyapı maliyeti ve 10 developer'lık bir ekipte
gateway politikalarının token maliyetine etkisi. Tüm token fiyatları Anthropic liste fiyatıdır
(Bedrock **global** endpoint bu fiyatlarla eşleşir, **regional** endpoint %10 primlidir). Kesin
rakam için [Bedrock fiyat sayfası](https://aws.amazon.com/bedrock/pricing/) ve kendi sözleşmen
geçerlidir; gateway'deki `PRICING_JSON` ile tabloyu güncelleyebilirsin.

## 1. Fiyat tablosu (USD / 1M token)

| Model | Input | Output | Cache write 5m | Cache write 1h | Cache read |
|---|---|---|---|---|---|
| Claude Opus 5.5 | 4.00 | 20.00 | 5.00 | 8.00 | 0.20 |
| Claude Sonnet 5.5 | 2.00 | 10.00 | 2.50 | 4.00 | 0.20 |
| Claude Haiku 4.5 | 1.00 | 5.00 | 1.25 | 2.00 | 0.10 |

Opus 5.5'te cache read base fiyatın %5'i, diğerlerinde %10'u. Bu fark Opus'ta uzun oturumları
göreceli olarak ucuzlatır ve "cache'i canlı tut" stratejisini daha değerli yapar.

## 2. Altyapı maliyeti (aylık, us-east-1, yaklaşık)

| Kalem | Hesap | Aylık |
|---|---|---|
| Fargate 2 task × (0.5 vCPU + 1 GB) | 2 × (0.5×$0.04048 + 1×$0.004445) × 730 sa | ~$36 |
| Application Load Balancer | $0.0225/sa × 730 + ~3 LCU | ~$20 |
| DynamoDB on-demand (2 tablo) | ~200K yazma + 100K okuma | ~$1 |
| CloudWatch Logs + EMF metrikleri | ~5 GB ingest, ~40 custom metric | ~$15 |
| CloudWatch dashboard + 3 alarm | 1 dashboard ücretsiz, alarm $0.10 | ~$1 |
| NAT Gateway | **yok** (public subnet + SG) | $0 |
| **Toplam** | | **~$70–75 / ay** |

Kıyas: 10 developer'ın token harcaması aşağıdaki modelde ~$2,400/ay. Altyapı, tasarrufun
ilk %3'üyle kendini öder.

Üretim için eklenebilecekler: NAT + private subnet (+$35/AZ), WAF (+$10), ACM sertifika ($0).

## 3. Baseline: bir developer'ın günü

Claude Code'un tipik ajan döngüsü için varsayımlar (OTel verisi gelince gerçek sayılarla değiştir):

| Parametre | Değer | Not |
|---|---|---|
| Oturum / gün | 6 | görev başına yeni oturum |
| API çağrısı (tur) / oturum | 30 | her tool çağrısı bir tur |
| Ortalama context / tur | 60K token | 20K'dan başlayıp 100K'ya büyür |
| Tur başına cache read | 54K | önceki prefix |
| Tur başına cache write | 5K | yeni tool çıktısı |
| Tur başına uncached input | 1K | kullanıcı mesajı, küçük farklar |
| Tur başına output | 800 | thinking dahil |
| Model | Opus 5.5 | effort `xhigh` (Claude Code varsayılanı) |
| Çalışma günü / ay | 21 | |

**Tur maliyeti (Opus 5.5):**

```
cache read   54,000 × $0.20 / 1M = $0.0108
cache write   5,000 × $5.00 / 1M = $0.0250
input         1,000 × $4.00 / 1M = $0.0040
output          800 × $20.0 / 1M = $0.0160
                                  --------
tur                               $0.0558
```

| Birim | Maliyet |
|---|---|
| Oturum (30 tur) | $1.67 |
| Gün (6 oturum) | $10.04 |
| Ay / developer | $211 |
| **Ay / 10 developer** | **$2,110** |

Buna arka plan istekleri eklenir: oturum başlığı, özetler, compaction. `ANTHROPIC_AUTH_TOKEN`
ile gateway üzerinden bağlanıldığında Claude Code bunları **ana modelle** gönderir (Haiku
pin'lenmemişse). Günde ~40 küçük istek × ~3K input × Opus fiyatı ≈ $0.60/gün → **$13/ay/dev**.
Subagent (Explore, Plan) kullanımı ortalama ekip için ana tüketimin ~%15'i ≈ **$32/ay/dev**.

**Düzeltilmiş baseline: ~$256/ay/developer, ~$2,560/ay/ekip.**

## 4. Kaldıraçlar ve beklenen etki

Her kaldıraç gateway'de bir ayardır. Etkiler bağımsız hesaplanmıştır; birleşik etki çarpımsaldır,
toplamsal değil.

### 4.1 Arka plan isteklerini Haiku'ya yönlendir

`ROUTE_AUXILIARY_MODEL=anthropic.claude-haiku-4-5` (veya developer tarafında
`ANTHROPIC_DEFAULT_HAIKU_MODEL`).

```
önce : 40 istek × 3K input × $4/1M + 40 × 200 out × $20/1M = $0.48 + $0.16 = $0.64/gün
sonra: 40 × 3K × $1/1M + 40 × 200 × $5/1M                  = $0.12 + $0.04 = $0.16/gün
```
**Tasarruf: ~$10/ay/dev, ekip %4.** Kalite riski yok: bu istekler başlık ve özet üretir.

### 4.2 Subagent'ları Sonnet 5.5'e yönlendir

`ROUTE_SUBAGENT_MODEL=anthropic.claude-sonnet-5-5`. Explore ve Plan subagent'ları dosya
okur ve özetler; Sonnet bu iş için yeterli.

```
subagent payı $32/ay/dev; Sonnet input/cache-write Opus'un yarısı, output yarısı
→ $32 → $16
```
**Tasarruf: ~$16/ay/dev, ekip %6.** Risk düşük; Plan subagent'ında kalite hissedilirse
sadece subagent'ı Opus'ta bırak (`x-claude-code-agent-type` ile ayrıştırmak sonraki sürüm).

### 4.3 Effort: xhigh → high

`EFFORT_MODE=fill`, `DEFAULT_EFFORT=high`. Claude Code effort göndermiyorsa gateway doldurur
(developer `/effort` ile seçtiyse dokunulmaz). Opus 5.5'te effort thinking derinliğini ve
tool çağrısı sayısını belirler. Anthropic'in rehberi: `high` çoğu kodlama işinde kalite kaybı
olmadan daha az token.

Varsayım: output token %30 azalır (800 → 560), tur sayısı %10 azalır (30 → 27).

```
tur: $0.0558 → cache read $0.0108 + write $0.025 + input $0.004 + output 560×$20/1M $0.0112 = $0.0510
oturum: 27 × $0.0510 = $1.38 (önce $1.67)
```
**Tasarruf: ~$37/ay/dev, ekip %14.** Bu, kaliteyle takas edilen tek kaldıraç. 2 developer'da
bir hafta dene, PR geri dönüş sayısını izle.

### 4.4 Tool çıktısı kısaltma

`TOOL_RESULT_MAX_CHARS=20000` (~5K token). Bir test veya build logu 20K token geldiğinde
sadece o turda değil, oturumun kalan her turunda cache read olarak ödenir.

```
1 büyük log (20K token), oturumun 15. turunda gelsin, 15 tur daha yaşasın:
  cache write: 20K × $5/1M            = $0.100
  cache read : 20K × 15 × $0.20/1M    = $0.060
  toplam                              = $0.160 / log
5K'ya kısaltılırsa                    = $0.040 / log  → $0.12 tasarruf
Oturum başına ortalama 1.5 büyük log → $0.18/oturum → 6 oturum → $1.08/gün
```
**Tasarruf: ~$23/ay/dev, ekip %9.** Risk: model kesilen kısmı tekrar isteyebilir; bu yüzden
eşik 20K ve baş+son korunur (hata mesajları genelde sondadır).

### 4.5 Cache TTL 1 saat: çoğunlukla **değmez**

`CACHE_TTL_1H=true` tüm yazmaları 2× fiyata çıkarır ($5 → $8/1M Opus'ta).

```
ek yazma maliyeti: 30 tur × 5K × $3/1M = $0.45 / oturum
bir cache miss'in bedeli (60K tekrar yazma): 60K × $5/1M = $0.30
```
1h TTL ancak oturum başına **1.5'ten fazla** 5 dakikalık ara varsa kazandırır. OTel'de
`x-claude-code-session-id` bazında tur arası boşluk dağılımına bak; developer'lar toplantıya
gidip gelen tipteyse aç, akıcı çalışıyorsa kapalı tut. Varsayılan: kapalı.

### 4.6 Bütçe aşımında Sonnet'e düşür

`BUDGET_ACTION=downgrade`, `DOWNGRADE_MODEL=anthropic.claude-sonnet-5-5`, developer başına
`dailyBudgetUsd`. Tasarruf değil, tavan. Sadece **yeni konuşmalarda** devreye girer; devam
eden konuşmada model değişmez (cache ve thinking bütünlüğü için).

## 5. Birleşik senaryo

| Senaryo | Ay / dev | Ay / 10 dev | Değişim |
|---|---|---|---|
| Baseline (Opus 5.5, xhigh, her şey Opus) | $256 | $2,560 | |
| **Faz 1: güvenli** (4.1 + 4.2 + 4.4) | $207 | $2,070 | **−19%** |
| **Faz 2: + effort high** (4.3) | $172 | $1,720 | **−33%** |
| Faz 2 + ana model Sonnet 5.5 (sadece referans) | $95 | $950 | −63% |

Son satır referans amaçlıdır: ana modeli değiştirmek developer kararı olmalı, gateway
politikası değil. Faz 1 ve 2 toplamı altyapı maliyetini ($75) ayda ~11 kat karşılar.

## 6. Ölçüm: hangi sayıya bakacaksın

Gateway her istekte CloudWatch'a şunları yazar (namespace `ClaudeGateway`):

| Metrik | Boyut | Ne söyler |
|---|---|---|
| `EstimatedCostUsd` | Developer, Model, RequestClass | Kim, hangi modelle, hangi iş sınıfında harcıyor |
| `CacheReadTokens / (InputTokens + CacheWriteTokens + CacheReadTokens)` | — | Cache hit oranı; %80 altıysa bir şey prefix'i bozuyor |
| `OutputTokens / toplam input` | — | Effort'un etkisi burada görünür |
| `Requests` by `RequestClass` | main / subagent / auxiliary / compaction | Yönlendirmenin kaç isteği etkilediği |
| Logs Insights: `SessionId` bazlı toplam | — | En pahalı 5 oturum, haftalık incelemenin konusu |

Başarı ölçütü "istek başına token" değil, **tamamlanan iş başına maliyet**. Effort düşürüp tur
sayısı artıyorsa kazanç yoktur; `Requests` ve `EstimatedCostUsd` birlikte okunmalı.
