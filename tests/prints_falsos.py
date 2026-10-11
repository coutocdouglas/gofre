"""Linhas de OCR FICTÍCIAS (nomes e valores inventados) com a mesma disposição dos prints reais do XP e do Inter.
Nenhum dado pessoal: servem só para testar a leitura sem precisar de imagem nem do motor de OCR."""


def L(x0, x1, y, texto):
    return {"x0": x0, "x1": x1, "y": y, "h": 28, "texto": texto, "conf": 0.9}


# --- XP: notificação (largura 1158)
NOTIF_XP = (1158, [
    L(162, 341, 41, "CartaoXp"), L(1031, 1122, 44, "13:03"),
    L(159, 1012, 86, "Compra de R$ 110,00 APROVADA em PADARIA"),
    L(160, 691, 128, "AURORA LTDA via cartao digital."),
])
NOTIF_XP_OCR_RUIM = (926, [                                  # o OCR leu "O" no lugar de zero
    L(129, 273, 33, "CartaoXp"), L(825, 897, 35, "13:03"),
    L(126, 810, 69, "Compra de R$ 110,O0 APROVADA em PADARIA"), L(127, 554, 102, "AURORALTDA via cartao digital."),
])

# --- Inter: notificação (largura 1290) — traz o final do cartão e "ontem/hoje" (a data NÃO é usada)
NOTIF_INTER = (1290, [
    L(232, 563, 47, "Comprano credito"), L(909, 1198, 50, "Yesterday,05:06"),
    L(231, 1103, 90, "Ola, Fulano. Voce acaba de comprar Rs 24,90 em"),
    L(232, 1185, 133, "MERCADO*MercadoTesteBrasilInt. A compra foi no credito nacional"),
    L(232, 639, 174, "como cartaofinal 7991."),
])

# --- XP: lista de lançamentos (largura 838): data, hora, nome, valor; ícone com letras soltas à esquerda
LISTA_XP = (838, [
    L(125, 226, 44, "Cartoes"), L(676, 770, 151, "Ordenar"), L(30, 340, 152, "51langamentos encontrados"),
    L(31, 156, 221, "09/10/2026"), L(30, 91, 291, "13:03"),
    L(605, 723, 371, "R$ 110,00"), L(118, 206, 373, "Assinatura"), L(47, 95, 378, "[000]"),
    L(29, 155, 465, "08/10/2026"), L(29, 94, 534, "20:26"),
    L(616, 723, 615, "R$ 21,52"), L(117, 344, 616, "LojaDoJoaoBeams"),
    L(30, 154, 709, "07/10/2026"), L(29, 94, 778, "22:40"),
    L(116, 494, 847, "99food *testeburgers-Burgersbelo"), L(610, 724, 867, "R$ 72,62"), L(45, 81, 868, "9W"), L(116, 248, 887, "Horizontbr"),
    L(28, 158, 967, "06/10/2026"), L(30, 87, 1037, "12:16"),
    L(113, 179, 1362, "Uber"), L(614, 722, 1361, "R$ 10,93"), L(32, 94, 1364, "uber"),
])

# --- Inter: movimentações (largura 878): "-R$" para gastos, categoria e data abaixo (ignoradas), nomes que quebram em 2 linhas
LISTA_INTER = (878, [
    L(135, 417, 34, "Movimentacoes"), L(78, 169, 168, "Todos"), L(242, 345, 167, "A vista"), L(421, 627, 168, "Parcelamentos"),
    L(48, 162, 328, "Outubro"),
    L(130, 441, 463, "RAPPI*RappiBrasilInt"), L(689, 830, 462, "-R$ 24,90"), L(131, 280, 508, "Transporte"), L(751, 831, 507, "08/10"),
    L(129, 197, 613, "BMB"), L(259, 393, 614, "*Teste"), L(671, 830, 613, "-R$ 554,44"), L(129, 225, 659, "Outros"), L(751, 831, 658, "05/10"),
    L(49, 180, 765, "Setembro"),
    L(131, 311, 899, "CONTA TESTE"), L(400, 467, 899, "SAO"), L(678, 830, 920, "-R$ 216,90"),
    L(130, 227, 940, "PAULO"), L(258, 324, 940, "BRA"), L(746, 831, 964, "27/09"), L(130, 224, 985, "Outros"),
    L(130, 545, 1282, "99Food58004585GABBelo"), L(690, 831, 1303, "-R$ 52,92"), L(131, 315, 1323, "HorizontBRA"),
    L(751, 831, 1348, "21/09"), L(130, 249, 1369, "Servicos"),
    L(130, 300, 1500, "ESTORNO LOJA"), L(700, 831, 1500, "R$ 15,00"), L(751, 831, 1545, "20/09"),     # sem "-": é crédito, não entra
])
