# Política de segurança

## Versões suportadas
| Versão | Suporte |
|---|---|
| 3.7.x (em produção em pdin.gplansis.com) | ✅ |
| < 3.7 | ❌ |

## Como relatar uma vulnerabilidade
**Não abra issue pública.** Envie um e-mail para **contato@gplansis.com** com o assunto `[SEGURANÇA] GPlanSiS|PDIN`, contendo:
- descrição do problema e impacto;
- passos para reproduzir (ou prova de conceito);
- versão, navegador e ambiente usados.

Confirmamos o recebimento assim que possível, mantemos você informado sobre a correção e damos crédito na publicação, se desejar.

## Escopo
Autenticação e sessão, perfis e permissões, isolamento entre projetos, servidor de arquivos estáticos (allowlist), endpoint de telemetria (token do gateway), formulário público de leads e funções `SECURITY DEFINER` do banco. Testes devem ser feitos numa instância local — **não** teste contra pdin.gplansis.com nem acesse dados de outras pessoas.
