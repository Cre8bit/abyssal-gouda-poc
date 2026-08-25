# Plan — Boucle de jeu « Golden Gouda »

Planification d'implémentation des deux récits d'expédition (2 et 4 joueurs), confrontée à la codebase existante. Objectif : boucle complète **Préparation → Exploration → Incident → Découverte → Fuite → Extraction**.

## 1. État des lieux

| Mécanique du récit | Existant | Écart |
|---|---|---|
| Monde fromager destructible | ✅ SDF + marching cubes par chunk, `digAt()` synchronisé P2P (~20 ms/remesh) | — |
| Biomes différenciés | ✅ 9 couches concentriques, matériaux/brouillard par zone (`gouda.js`) | Pas de modificateurs *physiques* par biome (nage collante) |
| Multijoueur | ⚠️ PeerJS en étoile : host ↔ N joiners | **Les joiners ne se voient pas entre eux** (data + voix). Bloquant pour le récit à 4 |
| Voix de proximité | ✅ HRTF spatialisé, mute | Pas de filtres d'état (gaz), pas de détection de parole |
| Golden Gouda | ⚠️ Cœur doré visuel (`createGoldCore`, `getGoldPos`) | Aucun ramassage, poids, ni extraction |
| Monstre | ✅ Angler-cat lurk/stalk/strike, host-autoritaire (broadcast 0.12 s) | Attiré par distance uniquement, pas par le bruit ; pas de leurre ni sensibilité lumière |
| Oxygène | ❌ | Jauge, stress, mort/respawn à créer |
| Inventaire / bâtons lumineux | ❌ (`T` = scatter debug) | À créer |
| Poches de vide, gaz, mort-aux-rats, piège | ❌ | À créer — mais le pipeline de génération seedée est idéal pour les placer |
| Bathyscaphe / sas / victoire | ❌ | Aucune condition de fin de partie |

## 2. Avis & recommandations

**La boucle cœur, c'est le portage du Gouda.** Tout le sel des deux récits (remontée laborieuse, entraide, fuite) découle de la flottabilité négative + l'extraction. Recommandation forte : livrer d'abord une *vertical slice* « ramasser → porter (lourd, sans lampe) → déposer au sas → victoire », avant tout hazard. Le jeu devient testable et fun immédiatement ; les dangers sont ensuite du contenu additif.

**Le déterminisme par seed est votre arme réseau.** Pièges, filons de mort-aux-rats, poches de vide et poches de gaz doivent être placés *à la génération* (dans `makeChunkData`/`placeChunks`) : tous les pairs ont le même monde pour zéro octet réseau. Seuls les *déclenchements* (piège claqué, poche percée) transitent, comme `dig` aujourd'hui.

**Répliquer des flags, pas des effets.** Ajouter un bitmask de statut au paquet d'état 30 Hz (`carrying | gassed | poisoned | trapped | speaking`). Chaque client applique ses effets localement (contrôles inversés, blur) ; les autres ne font que *rendre* ce que le flag implique (bulles, toux, lueur du porteur). Coût réseau : 1 octet.

**Effets voix côté récepteur.** Pour le gaz : ne pas toucher au flux sortant — insérer un `BiquadFilter` (lowpass) entre `MediaStreamSource` et `PannerNode` dans `voice.js`, activé quand le flag `gassed` du pair est levé. Les bruits de toux sont des samples locaux superposés. Simple, robuste, zéro re-négociation WebRTC.

**Budget rendu.** Bâtons lumineux : sprites additifs émissifs (instancés) pour tous + un pool de ~4 vraies `PointLight` attribuées aux bâtons les plus proches de la caméra. Gaz : particules sprites (réutiliser le système de `burstAt`/plancton), pas de vraie volumétrie. Le remesh reste mono-chunk, rien à changer.

**Réseau 4 joueurs : passer en mesh.** L'étoile actuelle casse le récit à 4 (un joiner ne voit ni n'entend les autres joiners). PeerJS permet le full mesh : à la connexion, le host envoie la liste des pairs, chaque joiner se connecte (data + call voix) aux autres. 4 joueurs = 6 liens data + 6 liens audio : trivial en bande passante (~paquets de 40 octets à 30 Hz). Alternative host-relay possible mais ajoute latence voix et complexité ; le mesh est plus simple ici. ⚠️ Risque : fiabilité du TURN public openrelay avec 6 liens — prévoir un fallback relay-par-host pour les paires qui échouent (v2).

**Autorité.** Garder le modèle actuel : le host arbitre tout ce qui est *contesté* (qui ramasse le Gouda, états du poisson) ; le reste est local + événement. Le transfert d'autorité à la déconnexion du host existe déjà pour le catfish — l'étendre aux items.

**Bruit = système, pas script.** Un score de bruit local (coups de pioche récents + volume micro via `AnalyserNode`) envoyé dans le paquet d'état ; le host l'injecte dans l'IA du catfish comme attracteur pondéré par la distance. Ça implémente d'un coup : forage bruyant, cris dans les micros, et les bulles de parole (même AnalyserNode).

## 3. Extensions d'architecture

- `src/items.js` — registre d'entités répliquées host-autoritaires (gouda, bâtons droppés, pièges déclenchés) : `{id, kind, pos, holder, state}`. Messages : `item-request` (joiner→host), `item-state` (host→tous). Snapshot complet envoyé à tout nouveau pair.
- `src/effects.js` — machine à états des statuts locaux (durées, stacking) + application du bitmask entrant aux rendus distants.
- `src/noise.js` — score de bruit local (pioche + micro), lissé, exposé au state packet et à l'audio (bulles).
- `gouda.js` — la génération pose en plus : filons mort-aux-rats (masque matériau interrogeable par `digAt`), poches de vide/gaz (cavités scellées taguées), points de piège (vase des grandes chambres). `digAt()` retourne ce qu'on a percé.
- `network.js` — mesh : message `peers` à la connexion, `connectToPeers()`, et par-pair `sendTo()`.

## 4. Phases & tickets

### Phase 0 — Fondations (réseau + survie) · ~4-5 j
- ✅ **T0.1 Mesh P2P N joueurs** : full mesh (host = introducteur, le nouveau venu compose vers chaque pair, data + voix). Double canal par paire : événements fiables/ordonnés (PeerJS) + poses 30 Hz sur RTCDataChannel négocié non-fiable/non-ordonné, paquets binaires 24 octets avec n° de séquence (les paquets périmés sont jetés), ping RTT par pair. Codec dans `src/protocol.js`, testé par `npm test`.
- ✅ **T0.2 Bitmask de statut** : `src/effects.js`, 7 bits dans l'octet 3 du paquet d'état, re-broadcast immédiat au changement (AC <100 ms). Debug console : `__abyssal.setLocalStatus(...)` en dev.
- ✅ **T0.3 Oxygène** : `src/oxygen.js` + jauge HUD, drain de base (~10 min), ×1.8 sprint, ×2 trapped, ×1.5 gassed ; blackout → respawn au spawn, recharge dans la zone du spawn (futur bathyscaphe). Élection déterministe de l'autorité poisson si l'hôte part.
- **T0.4 Bathyscaphe + sas** : ⏸ en attente du modèle 3D (la zone de recharge/respawn au spawn existe déjà — il ne manque que le visuel + l'enregistrement `preview.js`). *(1 j)*

### Phase 1 — Vertical slice Gouda · ~3-4 j — **le jeu devient un jeu**
- **T1.1 Gouda ramassable** : remplace le cœur décoratif par un item (`items.js`), arbitrage host du pickup, lueur jaune forte portée par le porteur. *(1 j)*
- **T1.2 Poids du Gouda** : flottabilité négative constante (~-4 u/s ramenée par le spam de nage), cap de vitesse réduit, **flashlight forcée off** pour le porteur, `G` pour lâcher/jeter (petite impulsion — permet le « jet dans le sas in extremis »). *(1 j)*
- **T1.3 Extraction & victoire** : Gouda dans le sas → écran de victoire (temps, stats), replay avec nouveau seed. AC : boucle 10-20 min jouable à 2. *(1 j)*

### Phase 2 — Navigation · ~2 j
- **T2.1 Hotbar minimale** : slots (bâtons ×N, pioche), molette/chiffres, compteur HUD. *(1 j)*
- **T2.2 Bâtons lumineux** : drop (touche), flottaison lente, réplication via `items.js`, rendu sprites + pool de 4 PointLights. AC : 60 fps avec 40 bâtons posés. *(1 j)*

### Phase 3 — Dangers du terrain (tous placés par seed) · ~5 j
- **T3.1 Poches de vide** : cavités scellées taguées à la génération ; percer déclenche N secondes de champ d'aspiration vers la poche (force > nage au centre) + son + particules. Événement `pocket` broadcast. *(1.5 j)*
- **T3.2 Gaz de fermentation** : idem, nuage de sprites verts qui gonfle ; dans le nuage : flag `gassed`, blur/teinte écran, drain O₂ léger ; côté pairs : lowpass voix + toux. *(1.5 j)*
- **T3.3 Mort-aux-rats** : filons rose fluo dans le masque matériau (visibles en surface du mesh via la teinte de veine) ; `digAt` sur filon → flag `poisoned` 10 s : contrôles inversés + visuel. *(1 j)*
- **T3.4 Piège à rat géant** : props posés dans la vase des grandes chambres ; contact → `trapped` (nage désactivée, drain O₂ ×2, cri utile en voix proximité) ; libération = dig précis sur le ressort (raycast < 1 u du point faible) par un coéquipier. Arbitrage host. *(1 j)*

### Phase 4 — Écologie sonore & monstre · ~4 j
- **T4.1 Bulles de parole** : `AnalyserNode` sur mic local (flag `speaking`) et sur chaque flux distant → `emitBreath`-like au masque du parleur. *(0.5 j)*
- **T4.2 Score de bruit** : `noise.js` (pioche + voix), champ `n` dans le state packet. *(0.5 j)*
- **T4.3 Catfish v2** : attracteur bruit dans l'IA host (remplace la détection pure distance), leurre = fausses lueurs jaune-gouda dans les biomes brumeux, éblouissement : ≥3 bâtons lumineux proches de sa tête → fuite/stun 5 s. *(2-3 j)*

### Phase 5 — Physique de biome · ~1 j
- **T5.1 Modificateurs par zone** : table biome → `{speedMult, fogBoost, drag}` (Roquefort : nage ×0.8, brouillard dense). Lecture de la zone via le rayon (structure en oignon = gratuit). *(0.5 j)*

**Dépendances clés** : T0.1 → tout le multi à 4 ; T0.2 → T3.2/T3.3/T3.4/T4.1 ; `items.js` (T1.1) → T2.2/T3.4 ; T4.2 → T4.3.

## 5. Écarts assumés avec les récits

- « Jauge O₂ qui descend plus vite à cause du stress » → modélisé par statut (trapped/gassed), pas par détection émotionnelle.
- Bâton tous les 15 m automatique → drop manuel (plus de gameplay, moins de magie).
- L'« algorithme de destruction dévoile un bloc corrompu » → les poches sont pré-placées par seed et révélées par le dig : même effet joueur, zéro coût réseau.
