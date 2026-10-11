"""Importação de faturas de cartão a partir de PDF.

Fluxo: LER (extrai as linhas do PDF) -> SUGERIR (cruza com o que já está lançado e com as regras
salvas) -> o usuário REVISA na tela -> CONFIRMAR (grava tudo de uma vez, como UMA ação no Desfazer).

O PDF é lido somente na memória: nunca é salvo em disco.
"""
