# 🎯 CHECKLIST DE SINCRONIZAÇÃO DE VÍDEO

## 📋 Problemas Identificados

### ✅ 1. Detecção de Silêncio - Método de Transcrição
**Problema:** A análise de silêncio no início/final só funciona com método 2 (Whisper-1 com timestamps)?
**Status:** ❌ PRECISA VERIFICAR

**Solução:**
- Método 1 (rápido): Usa ffmpeg `silencedetect` - precisa ser adaptado para detectar início/final
- Método 2 (preciso): Usa timestamps do Whisper - já funciona
- Ambos devem gerar `segments` com timestamps

---

### ✅ 2. Silêncios no MEIO do Vídeo
**Problema:** Se há silêncio de 10s no meio (ex: corte de cena), não é tratado
**Status:** ❌ NÃO TRATADO

**Cenário:**
```
Vídeo: [fala 0-100s] [SILÊNCIO 100-110s] [fala 110-200s]
Áudio dublado: [fala 0-X] [sem pausa] [fala X-Y]
Resultado: Dessincronização após o silêncio!
```

**Solução Proposta:**
- Detectar pausas/silêncios longos (>3s) entre segmentos
- Preservar esses silêncios no áudio dublado
- Ajustar velocidade de cada BLOCO de fala separadamente

---

### ✅ 3. Dessincronização Gradual (Minuto 5 vs 3:40)
**Problema:** No último teste, publicidade do min 5 estava no min 3:40 do áudio
**Status:** ❌ BUG CRÍTICO

**Análise:**
- Vídeo: 1018s
- Áudio TTS: ~600s
- Ratio: ~170% (precisa desacelerar muito)
- Resultado: Fala lenta, mas ainda dessincronizada no meio

**Causa Raiz Possível:**
1. Tradução ainda perdendo ~18% do conteúdo
2. Ajuste de velocidade GLOBAL não considera distribuição do texto
3. Silêncios no meio não preservados

---

### ✅ 4. Estrutura de Análise de Compilações
**Problema:** Precisamos entender ONDE e QUANDO ocorre a dessincronização
**Status:** ❌ SEM FERRAMENTAS

**Necessário:**
- Script para analisar áudio dublado vs original
- Detectar pontos de dessincronização
- Mapear eventos (publicidade, cortes) nos timestamps

---

## 🔧 PLANO DE AÇÃO

### FASE 1: Diagnóstico (FAZER AGORA)
- [ ] Criar script de análise de sincronização
- [ ] Comparar timestamps de eventos-chave
- [ ] Verificar método 1 vs método 2
- [ ] Mapear silêncios no meio do vídeo

### FASE 2: Correção de Detecção
- [ ] Garantir que ambos métodos detectam silêncios
- [ ] Detectar silêncios longos no MEIO (>3s)
- [ ] Criar estrutura de "blocos de fala"

### FASE 3: Sincronização Inteligente
- [ ] Ajustar velocidade por BLOCO ao invés de global
- [ ] Preservar pausas/silêncios entre blocos
- [ ] Validar sincronização ponto a ponto

### FASE 4: Melhorar Tradução
- [ ] Investigar por que ainda perde 18% do texto
- [ ] Ajustar prompt ou mudar estratégia
- [ ] Considerar tradução por segmentos

---

## 📊 Estrutura Proposta: Blocos de Fala

```javascript
[
  { type: 'silence', start: 0, end: 2, duration: 2 },
  { type: 'speech', start: 2, end: 100, duration: 98, text: '...' },
  { type: 'silence', start: 100, end: 110, duration: 10 }, // PAUSA LONGA
  { type: 'speech', start: 110, end: 200, duration: 90, text: '...' },
  { type: 'silence', start: 200, end: 202, duration: 2 }
]
```

Cada bloco de fala é ajustado independentemente!

---

## 🎬 Script de Análise Necessário

Criar: `analyze-sync.js`

Funcionalidades:
1. Extrair áudio do vídeo original e dublado
2. Detectar silêncios em ambos
3. Comparar timestamps de eventos
4. Gerar relatório visual
5. Identificar pontos de dessincronização

