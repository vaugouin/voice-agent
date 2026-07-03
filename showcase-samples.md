# Voice-agent showcase - evaluation samples inventory

_Source: `GET /voice-agent/tool/samples` (public proxy to the fastapi-text2sql `/samples` endpoint), `ui_language=en`, fetched 2026-07-03._

## Summary

- Total samples returned by `/samples`: **308**
- **Eligible for the showcase**: **237** (only these can appear; the showcase then randomly picks up to 18, round-robined across categories)
- Filtered out: **71**

Eligibility (front filter `selectShowcaseSamples`): `simulated_result` present, `result_kind` is `entity_rows` or `scalar`, and >=1 row. Anything `count` / `bound` / `unknown` / null, or an id-set that hydrated to 0 rows, is dropped.

### By simulated_result kind

| result_kind | count | eligible? |
|---|---|---|
| bound | 6 | no |
| count | 41 | no |
| entity_rows | 234 | yes |
| none | 21 | no |
| scalar | 6 | yes |

### By top-level category

| Category | total | eligible |
|---|---|---|
| Movies - Basic Queries | 8 | 4 |
| Movies - Movie title Queries | 5 | 5 |
| Movies - Technical &amp; Format Queries | 10 | 6 |
| Movies - Cast &amp; Crew Queries | 21 | 20 |
| Movies - Non English Queries | 18 | 18 |
| Movies - Budget &amp; Revenue Queries | 5 | 3 |
| Movies - Geography &amp; Language Queries | 9 | 5 |
| Movies - Genre Queries | 1 | 1 |
| Movies - Topics Queries | 4 | 3 |
| Movies - Collections and Universes Queries | 16 | 12 |
| Movies - Time-Based Queries | 7 | 2 |
| Movies - Character Queries | 10 | 10 |
| Movies - Awards Queries | 11 | 11 |
| Movies - Recognition &amp; Famous Lists Queries | 9 | 9 |
| Movies - Movements and Styles Queries | 5 | 3 |
| Movies - Complex Queries | 22 | 17 |
| Movies - ID Queries | 7 | 7 |
| Movies - Keyword &amp; Content Analysis | 3 | 3 |
| Movies - Questions with no answer | 3 | 0 |
| Movies - Recommendations | 1 | 1 |
| Movies - Images queries (posters) | 8 | 7 |
| Documentaries - Basic Queries | 6 | 4 |
| Movies and TV series queries | 3 | 1 |
| TV Series - Basic queries | 7 | 3 |
| TV Series - Serie title queries | 3 | 3 |
| TV Series - Cast &amp; Crew Queries | 6 | 6 |
| TV Series - Non English Queries | 5 | 5 |
| TV Series - Geography &amp; Language Queries | 3 | 0 |
| TV Series - Collections and Universes Queries | 1 | 1 |
| TV Series - Time-Based Queries | 1 | 1 |
| TV Series - Character Queries | 1 | 1 |
| TV Series - Genres Queries | 1 | 1 |
| TV Series - Image queries (posters) | 2 | 1 |
| TV Series - Awards Queries | 2 | 2 |
| TV Series - ID Queries | 3 | 3 |
| TV Series - Complex Queries | 1 | 1 |
| TV Series - Keyword &amp; Content Analysis | 1 | 1 |
| Persons - Basic queries | 7 | 2 |
| Persons - Person name queries | 5 | 5 |
| Persons - Non Latin queries | 12 | 12 |
| Persons - Images queries (portraits) | 5 | 3 |
| Persons - Character Queries | 2 | 2 |
| Persons - Cast &amp; Crew Queries | 6 | 5 |
| Persons - Geography and Language Queries | 2 | 2 |
| Persons - Group Queries | 6 | 3 |
| Persons - Birth and Death Queries | 7 | 1 |
| Persons - Biography Queries | 3 | 3 |
| Persons - Awards Queries | 8 | 7 |
| Persons - ID Queries | 4 | 4 |
| Videos queries | 6 | 3 |
| Production Companies &amp; Networks Queries | 6 | 4 |

## All samples

Legend: showcase = yes means the sample is eligible to appear.


### Movies - Basic Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2315 | Movies | count | no |
| 21 | Movie apocalypse now | entity_rows | yes |
| 790 | How many movies are there? | bound | no |
| 1048 | Movie The.Human.Condition.II.Road.to.Eternity | entity_rows | yes |
| 2342 | Trending movies right now | none | no |
| 82 | Movie one battle after another | entity_rows | yes |
| 252 | Movies named The Thing | entity_rows | yes |
| 2314 | Show me 5 random movies | count | no |

### Movies - Movie title Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 114 | The big Lebowski | entity_rows | yes |
| 117 | The Big Sleep | entity_rows | yes |
| 2213 | 2001: A SPACE ODYSSEY | entity_rows | yes |
| 2222 | Manhattan (1979) | entity_rows | yes |
| 2235 | Tommy (1975) | entity_rows | yes |

### Movies - Technical &amp; Format Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 3 | Which movies were filmed in 70mm format? | entity_rows | yes |
| 4 | List all movies shot in CinemaScope | entity_rows | yes |
| 6 | Which films have a 2.39:1 aspect ratio? | entity_rows | yes |
| 7 | Which movies were shot using Franscope technology? | entity_rows | yes |
| 14 | Movies shot in color with Humphrey Bogart | entity_rows | yes |
| 2339 | What color movies used Technicolor technology in the forties? | none | no |
| 50 | List movies with English primary language and shot in 4/3 aspect ratio | none | no |
| 2159 | Movies that are both in colors and black & white | entity_rows | yes |
| 2225 | List movies shot with Vistavision, display the more recent first | count | no |
| 2238 | Which movies used the rotoscoping animation technique? | count | no |

### Movies - Cast &amp; Crew Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 8 | What movies did Stanley Kubrick direct? | entity_rows | yes |
| 9 | Which films feature both Robert De Niro and Al Pacino? | entity_rows | yes |
| 10 | What movies did Akira Kurosawa write and direct? | entity_rows | yes |
| 12 | Which movies are starring Lauren Bacall and Humphrey Bogart? | entity_rows | yes |
| 13 | List movies directed by Sergio Leone and starring Clint Eastwood | entity_rows | yes |
| 20 | Who are the actors of the movie le bonheur by Agnès varda? | entity_rows | yes |
| 2327 | List movies starring Mel Blanc | entity_rows | yes |
| 29 | How many movies were directed by Martin Scorsese? | none | no |
| 35 | List documentaries shot by Agnès Varda | entity_rows | yes |
| 51 | Movies with Edith Head in the crew | entity_rows | yes |
| 58 | List of movies with Terry Southern writing credit | entity_rows | yes |
| 61 | Movie adaptations of Walter Scott | entity_rows | yes |
| 62 | List movies adapted from Tolkien's work | entity_rows | yes |
| 70 | Movies with cinematographer Raoul Coutard | entity_rows | yes |
| 2145 | Movie with both these persons in the crew: - Dario argento  - Bernardo Bertolucci | entity_rows | yes |
| 2163 | Actors from the film The Big Sleep directed by Howard Hawks | entity_rows | yes |
| 2198 | Which Criterion Collection movies stars Marlon Brando? | entity_rows | yes |
| 169 | Which movies did Greta Gerwig write but did not direct? | entity_rows | yes |
| 2224 | What movie cast included James Garner, Richard Attenbourough, Steve McQueen, Charles Bronson, Donald Pleasance, James Coburn, Gordon Jackson, Angus Lennie among many others | entity_rows | yes |
| 2254 | What are the Most Recent movies directed by Agnieszka Holland | entity_rows | yes |
| 2264 | List movies directed by Maurice Scherer | entity_rows | yes |

### Movies - Non English Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 1044 | Movie 新・男はつらいよ | entity_rows | yes |
| 534 | Movie il bell antonio | entity_rows | yes |
| 2174 | Movie Der siebente Kontinent | entity_rows | yes |
| 2175 | Movie Todo sobre mi madre | entity_rows | yes |
| 2176 | Movie Броненосец Потёмкин | entity_rows | yes |
| 2177 | Movie 花樣年華 | entity_rows | yes |
| 2178 | Movie 친절한 금자씨 | entity_rows | yes |
| 2179 | Movie کلوزآپ ، نمای نزدیک | entity_rows | yes |
| 2180 | Movie Kauas pilvet karkaavat | entity_rows | yes |
| 2181 | Spelfilm Fanny och Alexander | entity_rows | yes |
| 2182 | Film অপুর সংসার | entity_rows | yes |
| 2183 | Película Los olvidados | entity_rows | yes |
| 2184 | Film Spoorloos | entity_rows | yes |
| 2185 | Film Vredens dag | entity_rows | yes |
| 2186 | Film Hoří, má panenko | entity_rows | yes |
| 2187 | Film Affeksjonsverdi | entity_rows | yes |
| 955 | Movie le feu follet | entity_rows | yes |
| 740 | Movie 絞死刑 | entity_rows | yes |

### Movies - Budget &amp; Revenue Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 1 | What are the highest-grossing movies of all time? | entity_rows | yes |
| 54 | What is the revenue generated by the James Cameron's movie Titanic? | bound | no |
| 85 | What are the highest grossing pictures this year and what revenue for each movie? | none | no |
| 2214 | What are the highest budget ever for a movie? List 10 movies and show the budget | entity_rows | yes |
| 190 | Which Sci-Fi movies have a budget over $100M? | entity_rows | yes |

### Movies - Geography &amp; Language Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 48 | List Estonian movies | none | no |
| 49 | List Portuguese speaking movies | none | no |
| 2147 | List movies happening in San Francisco | entity_rows | yes |
| 2149 | List movies happening on the Moon | entity_rows | yes |
| 2150 | List movies shot in Namibia | entity_rows | yes |
| 2151 | In which city the action of movie Pulp Fiction takes place? | scalar | yes |
| 2155 | What are the narrative locations of the movie Pulp Fiction? | scalar | yes |
| 2156 | Where was shot the movie 2001 A Space Odyssey? | entity_rows | no |
| 2292 | List all narrative locations | count | no |

### Movies - Genre Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 26 | Adventure movie with Harrison Ford | entity_rows | yes |

### Movies - Topics Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 30 | Show me all World War II movies directed by John Ford | entity_rows | yes |
| 34 | Vietnam war movies | entity_rows | yes |
| 71 | List movies about time travel | none | no |
| 2152 | List topics of the movie Apocalypse Now | entity_rows | yes |

### Movies - Collections and Universes Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 19 | List movies in the flamenco trilogy | entity_rows | yes |
| 2331 | List collections with the highest ratings | none | no |
| 33 | Star Wars movies | entity_rows | yes |
| 2340 | List movies in the Mad Max collection | entity_rows | yes |
| 2346 | List movies in the Star Trek Franchise | entity_rows | yes |
| 46 | List movies in the Die Hard movie collection | entity_rows | yes |
| 60 | John Ford's movies in the cavalry trilogy | entity_rows | yes |
| 72 | Movies in the musashi samurai trilogy | entity_rows | yes |
| 2133 | List all the Harry Potter movies | entity_rows | yes |
| 2136 | List movies in park Chan wook's vengeance trilogy | entity_rows | yes |
| 2158 | James Bond collection | entity_rows | no |
| 2200 | In which trilogy is the movie « the good the bad the ugly » a part? | entity_rows | no |
| 2256 | Liste all movie collections with exactly 3 movies | count | no |
| 723 | What movies are in the Terry Gilliam's Imagination trilogy? | entity_rows | yes |
| 2277 | List James Bond movies ordered by release date | entity_rows | yes |
| 748 | What are the movies from the samouraï trilogy Musashi | entity_rows | yes |

### Movies - Time-Based Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2 | List all silent movies released after 1990 | entity_rows | yes |
| 2312 | List movies that will be released in the next 30 days | none | no |
| 42 | What are the highest grossing pictures this year? | none | no |
| 63 | Which Criterion Collection movies were released in 1967? | entity_rows | yes |
| 2161 | Which drama movies were released in 2026? | none | no |
| 2165 | List Sci-Fi movies released in the fifties | count | no |
| 2166 | List Science fiction feature films released in the fifties | count | no |

### Movies - Character Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 11 | What character did Harrison Ford play in Star Wars? | scalar | yes |
| 16 | List all movies in the Batman universe | entity_rows | yes |
| 17 | List all movies with the private investigator Philip Marlowe | entity_rows | yes |
| 32 | Movies having a Philip Marlowe character | entity_rows | yes |
| 41 | List Dracula movies | entity_rows | yes |
| 2348 | Movies with the Marco Polo character | entity_rows | yes |
| 2148 | List all movies with the R2-D2 character | entity_rows | yes |
| 2221 | Who starred as Rocky Balboa? | entity_rows | yes |
| 2293 | Movies with the Charlotte Corday character | entity_rows | yes |
| 2294 | List movies where there is a character named Philippe | entity_rows | yes |

### Movies - Awards Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2305 | List movies rewarded at the 84th Academy Awards | entity_rows | yes |
| 2311 | Which movies did win at the 1st academy awards? | entity_rows | yes |
| 2336 | List the films that have received the Louis Delluc Prize | entity_rows | yes |
| 2337 | Which movies received the Jean Vigo award? | entity_rows | yes |
| 39 | Movies who got an Academy award | entity_rows | yes |
| 2343 | Which movies did earn a “raspberry award for worst movie”? | entity_rows | yes |
| 65 | Movies who won the Palme d'Or | entity_rows | yes |
| 75 | Movies who won a Cesar du meilleur film award | entity_rows | yes |
| 2278 | Which Martin Scorcese movie won the Palme D’or ? | entity_rows | yes |
| 2289 | List movies awarded the bafta | entity_rows | yes |
| 2291 | List drama movies that were awarded the Golden Globe | entity_rows | yes |

### Movies - Recognition &amp; Famous Lists Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2308 | In which important lists is the movie Apocalypse Now? | entity_rows | yes |
| 40 | List movies in the Sight and Sound list | entity_rows | yes |
| 44 | Criterion Collection | entity_rows | yes |
| 59 | Films in top 250 IMDb | entity_rows | yes |
| 2216 | List Criterion Collection ordered by IMDb rating descending | entity_rows | yes |
| 2273 | List movies in the Wikiflix list | entity_rows | yes |
| 2274 | List movies in the National Film Registry | entity_rows | yes |
| 2275 | List movies in the Vatican's list of films | entity_rows | yes |
| 2297 | List movies in the Danny Peary's Cult Movies list | entity_rows | yes |

### Movies - Movements and Styles Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 31 | French New Wave films directed by François Truffaut | entity_rows | yes |
| 2335 | Is there a Pre-Code Hollywood movement? | none | no |
| 43 | List the Dogma 95 movies | entity_rows | yes |
| 68 | Czech New Wave movies | entity_rows | yes |
| 2300 | List New Hollywood movies | none | no |

### Movies - Complex Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 45 | List the movie directors with the most movies in the Criterion collection and tell how many movies for each director | entity_rows | yes |
| 47 | What in the cumulated duration of all movies in the Criterion Collection? | none | no |
| 1127 | Criterion collection movies starring max Von sydow | entity_rows | yes |
| 2162 | Give me the 50 highest-rated on IMDb English-language feature-length comedies from the 1950s | none | no |
| 2164 | Western movie directed by Robert Wise with Robert Mitchum | entity_rows | yes |
| 2168 | Technicolor long feature movies released in the 50s | entity_rows | yes |
| 2191 | List all movies with spine in the list defined by the first 20 values of the Fibonacci sequence | entity_rows | yes |
| 2192 | Which movies are both in the Sight & Sound list and in the Criterion Collection? | count | no |
| 2194 | Which movies both won the Cannes Palme d'Or and the Academy award for best picture? | entity_rows | yes |
| 2195 | list drama movies from the Sight and Sound list that were released in the 70s | entity_rows | yes |
| 2199 | List Criterion Collection movies that are both horror and science fiction | entity_rows | yes |
| 167 | List Clint Eastwood movies with a runtime over 140 minutes. | entity_rows | yes |
| 174 | Which movies adapted from a novel by Stephen King were released after 2000? | entity_rows | yes |
| 2223 | List feature films animation movies produced in France | count | no |
| 176 | Which movies in the Criterion Collection were released in the 1950s? | entity_rows | yes |
| 189 | Show all Western movies produced between 1950 and 1975 with the highest IMDb rankings first | entity_rows | yes |
| 2249 | Each statement has 3 parts: - item  - Property applying to item  - Property value (another item) Here is a list of statements:  - Movie, director credit, Stanley Kubrick  - Movie, is movie, 1 - Movie, year released, 1968 What is the result? | entity_rows | yes |
| 2253 | Among movies directed by Alfred Hitchcock, which have an IMDB rating above 8.0? | entity_rows | yes |
| 2255 | English language comedy films from the 1950s with IMDb rating > 7 and Criterion spine | count | no |
| 208 | What are the best sci-fi movies from the Criterion Collection? | entity_rows | yes |
| 2259 | List movies where the main character suffer from insomnia | entity_rows | yes |
| 474 | Who are the French movie directors with more cumulated revenue on movies they directed? | entity_rows | yes |

### Movies - ID Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 79 | Movie with IMDb id tt0033467 | entity_rows | yes |
| 80 | Movie with Wikidata id Q24815 | entity_rows | yes |
| 2173 | Movie with Spine n°1 | entity_rows | yes |
| 2188 | Movie tt0057427 | entity_rows | yes |
| 2189 | Movie with The Movie Database ID 490 | entity_rows | yes |
| 2190 | Movie with TMDb ID 68 | entity_rows | yes |
| 2201 | tt0033467 | entity_rows | yes |

### Movies - Keyword &amp; Content Analysis

| ID | Question | kind | showcase |
|---|---|---|---|
| 2137 | Here are the circumstances of a film — can you guess it? - There is a dance competition - Happens in Los Angeles  - There is violence and blood - It is an American film - It has a soundtrack featuring very well-known songs | entity_rows | yes |
| 2138 | Movies with John Travolta acting as the bad guy | entity_rows | yes |
| 2245 | Which animated film released in the last 10 years features bulls? | entity_rows | yes |

### Movies - Questions with no answer

| ID | Question | kind | showcase |
|---|---|---|---|
| 2332 | List movies with Sharon Stone released before 1970 | count | no |
| 2333 | List movies starring Humphrey Bogart and Lauren Bacall released in 1920 | count | no |
| 2350 | movies directed by Christopher Nolan released in 1850 | count | no |

### Movies - Recommendations

| ID | Question | kind | showcase |
|---|---|---|---|
| 2325 | I just watched Chinatown (1974) so what movie would you recommend to me? | entity_rows | yes |

### Movies - Images queries (posters)

| ID | Question | kind | showcase |
|---|---|---|---|
| 793 | How many movie images are there? | count | no |
| 27 | Posters of The Big Lebowski movie | entity_rows | yes |
| 55 | Display French posters of movies starring Louis de Funès | entity_rows | yes |
| 56 | Display Russian posters of movies starring Louis de Funès | entity_rows | yes |
| 57 | What are the Polish posters of the big Lebowski movie? | entity_rows | yes |
| 64 | Display Japanese posters of movies directed by Martin Scorcese | entity_rows | yes |
| 83 | What are the Japanese posters of the Taxi Driver movie? | entity_rows | yes |
| 731 | Polish posters of movies directed by Martin scorcese | entity_rows | yes |

### Documentaries - Basic Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2321 | Documentaries | count | no |
| 23 | Documentary Between Revolutions | entity_rows | yes |
| 2196 | In the Criterion Collection, display only documentaries | entity_rows | yes |
| 2197 | List all documentaries in the Sight and Sound list | entity_rows | yes |
| 2204 | Der Krieg der Mumien (1973) | entity_rows | yes |
| 2247 | How many documentaries are there? | bound | no |

### Movies and TV series queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 73 | List movies and series directed or created by David Benioff | entity_rows | yes |
| 946 | List content (movies and series) directed or created by alfred hitchcock | none | no |
| 2248 | List movies and series with action happening on the Moon | count | no |

### TV Series - Basic queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2317 | Series | count | no |
| 2318 | Show me 5 random series | count | no |
| 22 | TV serie Game of thrones | entity_rows | yes |
| 791 | How many series are there? | bound | no |
| 2345 | Trending series ordered by popularity | none | no |
| 53 | List Science fiction series with multiple seasons | entity_rows | yes |
| 2167 | List all crime miniseries | entity_rows | yes |

### TV Series - Serie title queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2157 | Game of Thrones | entity_rows | yes |
| 2209 | Severance | entity_rows | yes |
| 2211 | Black Mirror | entity_rows | yes |

### TV Series - Cast &amp; Crew Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 15 | List the TV series created by Alfred Hitchcock | entity_rows | yes |
| 2208 | List TV series starring Patricia Arquette | entity_rows | yes |
| 2219 | How old was Lucille Ball when the show "I Love Lucy" premiered? | scalar | yes |
| 2279 | List TV series starring Martin Freeman and Benedict Cumberbatch | entity_rows | yes |
| 2280 | List actors that appear in all seasons of Game of Thrones | entity_rows | yes |
| 2284 | Which TV series are an adaptation of a Stephen King book? | entity_rows | yes |

### TV Series - Non English Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2239 | TV Serie Chapeau melon et bottes de cuir | entity_rows | yes |
| 2240 | カウボーイビバップ | entity_rows | yes |
| 2241 | Serie la casa de papel | entity_rows | yes |
| 2242 | 오징어 게임 | entity_rows | yes |
| 2243 | TV Serie Мастер и Маргарита | entity_rows | yes |

### TV Series - Geography &amp; Language Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2229 | What are the narrative locations of tv series Game of Thrones? | count | no |
| 2230 | What are the filming locations of tv series Game of Thrones? | count | no |
| 2231 | List tv series happening in Paris | count | no |

### TV Series - Collections and Universes Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2347 | List series in the Star Trek Franchise | entity_rows | yes |

### TV Series - Time-Based Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2282 | List French TV Series created in the sixties | entity_rows | yes |

### TV Series - Character Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2220 | Who starred as the Six Million Dollar Man? | entity_rows | yes |

### TV Series - Genres Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2281 | List English TV Series of genre "Action & Adventure" | entity_rows | yes |

### TV Series - Image queries (posters)

| ID | Question | kind | showcase |
|---|---|---|---|
| 66 | Display French posters of the Game of Throne serie | entity_rows | yes |
| 2171 | How many serie images are there? | count | no |

### TV Series - Awards Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2283 | List series that received an Emmy Award | entity_rows | yes |
| 2290 | List series in the IMDb Top 250 TV show | entity_rows | yes |

### TV Series - ID Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2203 | tt0944947 | entity_rows | yes |
| 2210 | TV serie whose Wikidata id is Q1079 | entity_rows | yes |
| 2212 | Serie with TMDb ID 2473 | entity_rows | yes |

### TV Series - Complex Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2286 | What are the best US sci-fi series created in the sixties? | entity_rows | yes |

### TV Series - Keyword &amp; Content Analysis

| ID | Question | kind | showcase |
|---|---|---|---|
| 2285 | In which serie is there a chemistry teacher diagnosed with cancer and then becomes a drug dealer? | entity_rows | yes |

### Persons - Basic queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2316 | persons | count | no |
| 2319 | Actresses | count | no |
| 2320 | Directors | count | no |
| 792 | How many persons are there? | bound | no |
| 28 | Person sacha guitry | entity_rows | yes |
| 2344 | Who are trending persons these days? | none | no |
| 74 | Who is Stanley Kubrick? | entity_rows | yes |

### Persons - Person name queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 274 | J. K. Rowling | entity_rows | yes |
| 1103 | Brigitte bardot | entity_rows | yes |
| 1107 | Jean Dujardin | entity_rows | yes |
| 1120 | Charlie Chaplin | entity_rows | yes |
| 2153 | André de Toth | entity_rows | yes |

### Persons - Non Latin queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2257 | 島崎捷爾 | entity_rows | yes |
| 2258 | محسن مخملباف | entity_rows | yes |
| 2260 | Андрей Арсеньевич Тарковский | entity_rows | yes |
| 2261 | 박찬욱 | entity_rows | yes |
| 2262 | チャールズ・チャップリン | entity_rows | yes |
| 2263 | ทัชชกร ยีรัมย์ | entity_rows | yes |
| 2265 | Κώστας Γαβράς | entity_rows | yes |
| 2266 | מנחם גולן; | entity_rows | yes |
| 2267 | Շառլ Ազնավուր | entity_rows | yes |
| 2268 | മനോജ് നെല്ലിയാട്ട് ശ്യാമളന്‍ | entity_rows | yes |
| 2269 | प्रियंका चोपड़ा | entity_rows | yes |
| 2270 | ልጅ ተፈሪ መኮንን | entity_rows | yes |

### Persons - Images queries (portraits)

| ID | Question | kind | showcase |
|---|---|---|---|
| 18 | Pictures of Gary cooper | entity_rows | yes |
| 2322 | Show me random person pictures | count | no |
| 38 | Images of De Niro | entity_rows | yes |
| 2160 | Show me Humphrey Bogart pictures | entity_rows | yes |
| 2172 | How many person images are there? | count | no |

### Persons - Character Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2215 | List all actors that played the role of Sherlock Holmes in movies | entity_rows | yes |
| 2218 | List all actors that played the role of Sherlock Holmes in series | entity_rows | yes |

### Persons - Cast &amp; Crew Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2323 | List all professions | count | no |
| 36 | Actress Sharon tate | entity_rows | yes |
| 67 | Composer Frederic Chopin | entity_rows | yes |
| 69 | Cinematographer Darius Khondji | entity_rows | yes |
| 2143 | Which actor is playing in both movies:  - The Big Lebowski  - Tron | entity_rows | yes |
| 2144 | Which actors are playing in both movies:  - La grande vadrouille - Le corniaud | entity_rows | yes |

### Persons - Geography and Language Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 52 | What are the most famous persons born in New Zealand? | entity_rows | yes |
| 2205 | List Japanese directors | entity_rows | yes |

### Persons - Group Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2226 | Who are the members of The Beatles? | entity_rows | yes |
| 2232 | List the members of The Monty Python | count | no |
| 2233 | Which actors are members of the Royal Shakespeare Company? | count | no |
| 2234 | Who were the Marx Brothers? | count | no |
| 2295 | List persons member of Les Cahiers du Cinéma | entity_rows | yes |
| 2298 | List members of the Dziga Vertov Group | entity_rows | yes |

### Persons - Birth and Death Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2324 | List all persons who died recently | count | no |
| 2338 | List actors born in 67 | count | no |
| 2236 | List actors who died in a car accident | count | no |
| 2237 | Who are the directors or writers who commited suicide? | count | no |
| 2250 | Which movie directors died in 2025? | entity_rows | yes |
| 2251 | List movie directors that were born in the nineteenth century | count | no |
| 2252 | List directors that were born before the 20th century | count | no |

### Persons - Biography Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2341 | What was the age of Joan Crawford when she starred in Sudden Fear? | scalar | yes |
| 2287 | List US actresses that were married four times or more | entity_rows | yes |
| 2288 | List famous actors that had previously a career in the circus | entity_rows | yes |

### Persons - Awards Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2304 | List persons rewarded at the 84th Academy Awards | entity_rows | yes |
| 2309 | List all persons with the following award: a star on Hollywood Walk of Fame | entity_rows | yes |
| 2310 | Which persons did win at the 1st academy awards? | entity_rows | yes |
| 2313 | How many Academy awards did Katharine Hepburn won? | scalar | yes |
| 2349 | How many Academy Awards did Walt Disney won? | bound | no |
| 2301 | List actresses that received several academy awards for best actress | entity_rows | yes |
| 2302 | List actors who received the Academy Award for best supporting actor | entity_rows | yes |
| 2303 | List persons awarded an Honorary César | entity_rows | yes |

### Persons - ID Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 81 | Person with IMDb id nm0000003 | entity_rows | yes |
| 2202 | nm0806041 | entity_rows | yes |
| 2206 | Person with wikidata id Q30875 | entity_rows | yes |
| 2207 | Person with TMDb id 1 | entity_rows | yes |

### Videos queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 2326 | Show me 5 random movie trailer videos | count | no |
| 76 | List videos about the star wars movie | entity_rows | yes |
| 77 | List videos about the Game of Thrones serie | entity_rows | yes |
| 78 | List all videos about movies starring Humphrey Bogart | entity_rows | yes |
| 2169 | How many movie videos are there? | count | no |
| 2170 | How many serie videos are there? | count | no |

### Production Companies &amp; Networks Queries

| ID | Question | kind | showcase |
|---|---|---|---|
| 24 | Production company Pixar | entity_rows | yes |
| 25 | Network Netflix | entity_rows | yes |
| 37 | What are the movies produced by lucasfilm? | entity_rows | yes |
| 416 | What movies were produced by the Pixar production company? | entity_rows | yes |
| 2244 | Ginza cosmetics | none | no |
| 204 | What companies produced movies with budgets over $200 million? | none | no |
