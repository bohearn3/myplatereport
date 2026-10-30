#!/usr/bin/env python3
"""Builds src/data/schools.json: every D1 and D2 baseball school with its conference for the 2026 and 2027 seasons.

Sources
- D1 2027: Wikipedia "List of NCAA Division I baseball programs" ("affiliations are current for the upcoming 2027 season"), Oct 29 2026.
- D1 2026: same list with the 22 post-2026 baseball moves from Wikipedia "2026 NCAA Division I baseball season" undone,
  plus the WAC -> United Athletic Conference rebrand (July 2026).
- D2 2026: NCSA "Division 2 baseball colleges" list, Oct 29 2026, with its conference errors corrected (see FIXES), plus schools it lacks.
- D2 2027: same as 2026 except schools known to move (no full 2027 D2 list was available).
"""
import json, re, sys, collections, os
HERE = os.path.dirname(os.path.abspath(__file__))

D1_CONF = {
    'America East': 'America East', 'American': 'American', 'Atlantic Coast': 'ACC', 'ASUN': 'ASUN', 'Atlantic 10': 'A-10',
    'Big East': 'Big East', 'Big South': 'Big South', 'Big Ten': 'Big Ten', 'Big 12': 'Big 12', 'Big West': 'Big West',
    'Coastal Athletic': 'CAA', 'Conference USA': 'C-USA', 'Horizon League': 'Horizon', 'Ivy League': 'Ivy', 'Metro': 'MAAC',
    'Mid-American': 'MAC', 'Missouri Valley': 'MVC', 'Mountain West': 'MWC', 'NEC': 'NEC', 'Ohio Valley': 'OVC', 'Pac-12': 'Pac-12',
    'Patriot League': 'Patriot', 'Southeastern': 'SEC', 'Southern': 'SoCon', 'Southland': 'Southland', 'SWAC': 'SWAC',
    'The Summit': 'Summit', 'Sun Belt': 'Sun Belt', 'United Athletic': 'UAC', 'West Coast': 'WCC',
}
CONF_FULL = {
    'America East': 'America East Conference', 'American': 'American Conference', 'ACC': 'Atlantic Coast Conference', 'ASUN': 'ASUN Conference',
    'A-10': 'Atlantic 10 Conference', 'Big East': 'Big East Conference', 'Big South': 'Big South Conference', 'Big Ten': 'Big Ten Conference',
    'Big 12': 'Big 12 Conference', 'Big West': 'Big West Conference', 'CAA': 'Coastal Athletic Association', 'C-USA': 'Conference USA',
    'Horizon': 'Horizon League', 'Ivy': 'Ivy League', 'MAAC': 'Metro Atlantic Athletic Conference', 'MAC': 'Mid-American Conference',
    'MVC': 'Missouri Valley Conference', 'MWC': 'Mountain West Conference', 'NEC': 'Northeast Conference', 'OVC': 'Ohio Valley Conference',
    'Pac-12': 'Pac-12 Conference', 'Patriot': 'Patriot League', 'SEC': 'Southeastern Conference', 'SoCon': 'Southern Conference',
    'Southland': 'Southland Conference', 'SWAC': 'Southwestern Athletic Conference', 'Summit': 'Summit League', 'Sun Belt': 'Sun Belt Conference',
    'UAC': 'United Athletic Conference', 'WAC': 'Western Athletic Conference', 'WCC': 'West Coast Conference', 'Independent': 'Independent',
    'RMAC': 'Rocky Mountain Athletic Conference', 'NE10': 'Northeast-10 Conference', 'SIAC': 'Southern Intercollegiate Athletic Conference',
    'SAC': 'South Atlantic Conference', 'LSC': 'Lone Star Conference', 'GAC': 'Great American Conference', 'G-MAC': 'Great Midwest Athletic Conference',
    'GSC': 'Gulf South Conference', 'PBC': 'Peach Belt Conference', 'NSIC': 'Northern Sun Intercollegiate Conference', 'SSC': 'Sunshine State Conference',
    'Conference Carolinas': 'Conference Carolinas', 'PacWest': 'Pacific West Conference', 'CIAA': 'Central Intercollegiate Athletic Association',
    'CACC': 'Central Atlantic Collegiate Conference', 'CCAA': 'California Collegiate Athletic Association', 'GNAC': 'Great Northwest Athletic Conference',
    'PSAC': 'Pennsylvania State Athletic Conference', 'MEC': 'Mountain East Conference', 'ECC': 'East Coast Conference',
    'SCIAC': 'Southern California Intercollegiate Athletic Conference', 'NWC': 'Northwest Conference', 'UAA': 'University Athletic Association',
    'ODAC': 'Old Dominion Athletic Conference', 'MIAA (Michigan)': 'Michigan Intercollegiate Athletic Association', 'Big 8 (CCCAA)': 'Big 8 Conference (California Community College Athletic Association)',
    'Exhibition': 'Exhibition / international opponent',
    'GLIAC': 'Great Lakes Intercollegiate Athletic Conference', 'GLVC': 'Great Lakes Valley Conference', 'MIAA': 'Mid-America Intercollegiate Athletics Association',
}
D2_CONF = {
    'Rocky Mountain Athletic Conference': 'RMAC', 'Northeast-10 Conference': 'NE10', 'Southern Intercollegiate Athletic Conference': 'SIAC',
    'South Atlantic Conference': 'SAC', 'Lone Star Conference': 'LSC', 'Lone Star Conference (LSC)': 'LSC', 'Great American Conference': 'GAC',
    'Great Midwest Athletic Conference': 'G-MAC', 'Gulf South Conference': 'GSC', 'Peach Belt Conference': 'PBC',
    'Northern Sun Intercollegiate Conference': 'NSIC', 'Sunshine State Conference': 'SSC', 'Conference Carolinas': 'Conference Carolinas',
    'Conference Carolinas (CC)': 'Conference Carolinas', 'Pacific West Conference': 'PacWest', 'Central Intercollegiate Athletic Association': 'CIAA',
    'Central Atlantic Collegiate Conference': 'CACC', 'California Collegiate Athletic Association': 'CCAA', 'Great Northwest Athletic Conference': 'GNAC',
    'Pennsylvania State Athletic Conference': 'PSAC', 'Mountain East Conference': 'MEC', 'East Coast Conference': 'ECC',
    'Great Lakes Intercollegiate Athletic Conference': 'GLIAC', 'Great Lakes Valley Conference': 'GLVC',
    # NCSA labels the MIAA (Mid-America Intercollegiate Athletics Association) as "Michigan Intercollegiate Athletic Association".
    'Michigan Intercollegiate Athletic Association': 'MIAA', 'Independent': 'Independent',
}
# NCSA rows whose conference is wrong (an NAIA, D3 or unrelated conference), with the correct D2 baseball conference and why.
FIXES = {
    'Dominican University New York': ('CACC', 'CACC member list (Wikipedia)'),
    'Georgian Court University': ('CACC', 'CACC member list (Wikipedia)'),
    'Holy Family University': ('CACC', 'CACC member list (Wikipedia)'),
    'Thomas Jefferson University': ('CACC', 'CACC member list (Wikipedia)'),
    'Jessup University': ('PacWest', '2026 PacWest baseball preseason poll'),
    'Menlo College': ('PacWest', '2026 PacWest baseball preseason poll'),
    'Vanguard University of Southern California': ('PacWest', '2026 PacWest baseball preseason poll'),
    'Westmont College': ('PacWest', '2026 PacWest baseball preseason poll'),
    'Ferrum College': ('Conference Carolinas', 'Joined Conference Carolinas (2024 announcement)'),
    'Roosevelt University': ('GLIAC', 'GLIAC member since July 2024; 2026 GLIAC baseball schedule'),
    'Lincoln University – Missouri': ('MIAA', 'MIAA member (NCSA lists a non-D2 conference)'),
    'Emory & Henry University': ('SAC', 'SAC member since leaving the ODAC (NCSA lists the D3 ODAC)'),
    'Sul Ross State University': ('LSC', 'Lone Star Conference member (NCSA lists the D3 ASC)'),
    'University of Texas – Dallas': ('LSC', 'Lone Star Conference member (NCSA lists the D3 ASC)'),
    'University of Jamestown': ('NSIC', 'NSIC member (NCSA lists the NAIA GPAC)'),
}
# D2 schools missing from the NCSA list
D2_EXTRA = [
    ('Azusa Pacific University', 'Azusa, California', 'PacWest', '2026 PacWest baseball preseason poll'),
]
# D1 baseball moves after the 2026 season (Wikipedia, 2026 NCAA Division I baseball season): short name -> 2026 conference
D1_2026 = {
    'Austin Peay': 'ASUN', 'Cal Baptist': 'WAC', 'Central Arkansas': 'ASUN', 'DBU': 'C-USA', 'EKU': 'ASUN', 'Fresno State': 'MWC',
    'Gonzaga': 'WCC', 'Hawaii': 'Big West', 'Little Rock': 'OVC', 'Louisiana Tech': 'C-USA', 'North Alabama': 'ASUN',
    'Northern Illinois': 'MAC', 'Oregon State': 'Independent', 'Sacramento State': 'WAC', 'San Diego State': 'MWC',
    'Tennessee Tech': 'OVC', 'Texas State': 'Sun Belt', 'UC Davis': 'Big West', 'Utah Tech': 'WAC', 'Utah Valley': 'WAC',
    'Washington State': 'MWC', 'West Georgia': 'ASUN',
    # WAC schools that stayed when the WAC became the United Athletic Conference in July 2026
    'Abilene Christian': 'WAC', 'Tarleton State': 'WAC', 'UT Arlington': 'WAC',
}
D1_2026_D2 = {'West Florida': 'GSC'}  # D2 (Gulf South) in 2026, D1 ASUN from 2027

# Display names for long official names (others are derived)
SHORT = {
    'California State Polytechnic University – Pomona': 'Cal Poly Pomona', 'California State University – Dominguez Hills': 'Cal State Dominguez Hills',
    'California State University – East Bay': 'Cal State East Bay', 'California State University – Los Angeles': 'Cal State LA',
    'California State University – Monterey Bay': 'CSU Monterey Bay', 'California State University – San Marcos': 'Cal State San Marcos',
    'California State University – Stanislaus': 'Stanislaus State', 'California State University, Chico': 'Chico State',
    'California State University, San Bernardino': 'Cal State San Bernardino', 'Colorado State University Pueblo': 'CSU Pueblo',
    'Metropolitan State University of Denver': 'MSU Denver', 'University of Colorado – Colorado Springs': 'UCCS',
    'Colorado School of Mines': 'Colorado Mines', 'Chaminade University of Honolulu': 'Chaminade', 'University of Hawaii at Hilo': 'Hawaii Hilo',
    'Hawaii Pacific University': 'Hawaii Pacific', 'Point Loma Nazarene University': 'Point Loma', 'Concordia University Irvine': 'Concordia Irvine',
    'Concordia University – St. Paul': 'Concordia St. Paul', 'Vanguard University of Southern California': 'Vanguard',
    'Montana State University – Billings': 'MSU Billings', 'Minnesota State University, Mankato': 'Minnesota State',
    'Embry-Riddle Aeronautical University – Daytona Beach': 'Embry-Riddle', 'Florida Institute of Technology': 'Florida Tech',
    'The University of Alabama in Huntsville': 'UAH', "The University of Virginia's College at Wise": 'UVA Wise',
    'The University of West Alabama': 'West Alabama', 'Auburn University at Montgomery': 'AUM', 'University of Missouri—St. Louis': 'UMSL',
    'Missouri University of Science and Technology': 'Missouri S&T', 'University of North Carolina at Pembroke': 'UNC Pembroke',
    'University of Pittsburgh – Johnstown': 'Pitt-Johnstown', 'University of Arkansas at Fort Smith': 'UAFS', 'University of Arkansas at Monticello': 'UAM',
    'University of Texas – Permian Basin': 'UT Permian Basin', 'University of Texas – Tyler': 'UT Tyler', 'University of Texas – Dallas': 'UT Dallas',
    'Texas A&M University – Kingsville': 'Texas A&M-Kingsville', 'Texas A&M International University': 'Texas A&M International',
    'Anderson University – South Carolina': 'Anderson (SC)', 'King University – Tennessee': 'King (TN)', 'Lincoln University – Missouri': 'Lincoln (MO)',
    'Lincoln University of Pennsylvania': 'Lincoln (PA)', 'Northwood University – Midland': 'Northwood', 'Flagler College – St. Augustine': 'Flagler',
    'Commonwealth University – Bloomsburg': 'Bloomsburg', 'Commonwealth University – Lock Haven': 'Lock Haven', 'Commonwealth University – Mansfield': 'Mansfield',
    'Maryville University of St. Louis': 'Maryville', 'Dominican University New York': 'Dominican (NY)', 'Georgia College & State University': 'Georgia College',
    'University of South Carolina Aiken': 'USC Aiken', 'University of South Carolina Beaufort': 'USC Beaufort', 'Davis & Elkins College': 'Davis & Elkins',
    'Mississippi Christian University': 'Mississippi Christian', "St. Mary's University": "St. Mary's (TX)", 'Saint Martin\'s University': "Saint Martin's",
    'Azusa Pacific University': 'Azusa Pacific', 'East Stroudsburg University of Pennsylvania': 'East Stroudsburg',
}

def derive_short(name):
    if name in SHORT: return SHORT[name]
    n = name
    for pre in ('The University of ', 'University of ', 'The '):
        if n.startswith(pre): n = n[len(pre):]
    n = re.sub(r' (University|College)( of Pennsylvania)?$', '', n)
    n = re.sub(r' University of Pennsylvania$', '', n)
    return n.strip()

def d1_rows():
    out = []
    for line in open(HERE + '/d1_2027.txt', encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#'): continue
        school, nick, state, conf = [x.strip() for x in line.split('|')]
        m = re.match(r'^(.*?) \((.*)\)$', school)
        official, aliases = (m.group(1), [a.strip() for a in m.group(2).split('/')]) if m else (school, [])
        short = aliases[0] if aliases else derive_short(official)
        out.append({'name': official, 'short': short, 'aliases': aliases, 'nickname': nick, 'state': state, 'conf27': D1_CONF[conf]})
    return out

def main():
    schools, notes = [], []
    seen = set()
    for r in d1_rows():
        key = r['short']
        if key in seen: sys.exit(f'duplicate short name {key}')
        seen.add(key)
        c27 = r['conf27']; d27 = 'D1'
        c26, d26 = c27, 'D1'
        hit = [a for a in [r['short']] + r['aliases'] if a in D1_2026]
        if hit: c26 = D1_2026[hit[0]]; notes.append(f"D1 2026 change: {r['short']}: {c26} (2026) -> {c27} (2027)")
        hit2 = [a for a in [r['short']] + r['aliases'] if a in D1_2026_D2]
        if hit2: c26, d26 = D1_2026_D2[hit2[0]], 'D2'; notes.append(f"{r['short']}: D2 {c26} (2026) -> D1 {c27} (2027)")
        schools.append({'name': r['name'], 'short': r['short'], 'aliases': r['aliases'], 'nickname': r['nickname'], 'state': r['state'],
                        'seasons': {'2026': {'conf': c26, 'div': d26}, '2027': {'conf': c27, 'div': d27}}})
    used = set(D1_2026) | set(D1_2026_D2)
    missing = used - {a for s in schools for a in [s['short']] + s['aliases']}
    if missing: sys.exit(f'2026 moves not matched: {missing}')

    fixes = []
    rows = [l.rstrip('\n').split('|') for l in open(HERE + '/d2_ncsa.txt', encoding='utf-8') if l.strip()]
    for name, place, conf in rows:
        if name in FIXES:
            c, why = FIXES[name]; fixes.append(f'{name}: NCSA "{conf}" -> {c} ({why})')
        else:
            if conf not in D2_CONF: sys.exit(f'unknown D2 conference {conf} for {name}')
            c = D2_CONF[conf]
        short = derive_short(name)
        if short in seen: short = f'{short} ({place.split(", ")[-1]})'
        seen.add(short)
        schools.append({'name': name, 'short': short, 'aliases': [], 'nickname': None, 'state': place.split(', ')[-1],
                        'seasons': {'2026': {'conf': c, 'div': 'D2'}, '2027': {'conf': c, 'div': 'D2'}}})
    for name, place, c, why in D2_EXTRA:
        short = derive_short(name); seen.add(short)
        fixes.append(f'{name}: added (not on the NCSA list) as {c} ({why})')
        schools.append({'name': name, 'short': short, 'aliases': [], 'nickname': None, 'state': place.split(', ')[-1],
                        'seasons': {'2026': {'conf': c, 'div': 'D2'}, '2027': {'conf': c, 'div': 'D2'}}})

    # D3, junior college and international teams seen in our files (other.txt)
    for line in open(HERE + '/other.txt', encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#'): continue
        name, short, nick, state, div, conf = [x.strip() for x in line.split('|')]
        if short in seen: sys.exit(f'duplicate short name {short}')
        if conf not in CONF_FULL: sys.exit(f'unknown conference {conf}')
        seen.add(short)
        schools.append({'name': name, 'short': short, 'aliases': [], 'nickname': nick, 'state': state,
                        'seasons': {'2026': {'conf': conf, 'div': div}, '2027': {'conf': conf, 'div': div}}})

    out = {
        'built': '2026-10-29',
        'seasons': ['2026', '2027'],
        'note': 'Season = the spring season year; fall games count toward the next season (Fall 2026 scrimmages use 2027 conferences).',
        'sources': [
            'D1 2027: Wikipedia, List of NCAA Division I baseball programs (affiliations for the 2027 season)',
            'D1 2026: same list with post-2026 baseball moves from Wikipedia, 2026 NCAA Division I baseball season, undone',
            'D2: NCSA, Division 2 baseball colleges (2026), corrected where NCSA lists a non-D2 conference',
            'D3 / JUCO / international: teams seen in our Trackman files (SCIAC and NWC in full), scripts/schools/other.txt',
        ],
        'conferences': {k: v for k, v in sorted(CONF_FULL.items())},
        'schools': sorted(schools, key=lambda s: s['short'].lower()),
    }
    json.dump(out, open(HERE + '/../../src/data/schools.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    by = collections.Counter((s['seasons']['2026']['div'], s['seasons']['2026']['conf']) for s in schools)
    print(len(schools), 'schools;', sum(1 for s in schools if s['seasons']['2026']['div'] == 'D1'), 'D1 in 2026,', sum(1 for s in schools if s['seasons']['2027']['div'] == 'D1'), 'D1 in 2027')
    print('\n'.join(notes)); print('--- D2 corrections'); print('\n'.join(fixes))
    print('--- 2026 conference sizes'); print(', '.join(f'{c}:{n}' for (d, c), n in sorted(by.items())))

if __name__ == '__main__':
    main()
