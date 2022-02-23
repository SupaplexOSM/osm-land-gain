import os, processing, time, csv
from datetime import date

nodes = QgsProject.instance().mapLayersByName('OSM data nodes')[0]
grid = QgsProject.instance().mapLayersByName('grid')[0]
today = date.today()

#Bearbeitungszahlen nach Aktivitätsschwerpunkten gewichten?
#(zweie Schleife notwendig)
activity_weight = True

#Gewichtungsfaktor-Verstärker für lokale Aktivitätsschwerpunkte der Mapper
activity_weight_multiplicator = 3

#Bearbeitungszahlen für bestimmte user abspeichern
save_sum_for_user = []
#dabei nach Aktualität gewichtet oder ungewichtete Zahlen speichern?
save_sum_weight = False

#csv-Datei schreiben?
write_user_stat = True
write_user_stat_path = '/.../data/user_stat.csv'

user_dict = {}
grid_dict = {}

grid.startEditing()

#neue Gitterfeld-Attribute und User-Namen in der Attributtabelle ergänzen, wenn noch nicht vorhanden
#"localist": lokal aktiver Mapper (gewichtet nach aktuellen Aktivitätszonen)
#"activist": gegenwärtig aktivster Mapper (gewichtet nach Aktualität der Bearbeitungen)
#"master": alltime aktivster Mapper
for attribute in ['@localist', '@activist', '@master']:
    if grid.dataProvider().fieldNameIndex(attribute) == -1:
        grid.dataProvider().addAttributes([QgsField(attribute, QVariant.String)])
#"nodecount": Summe aller Bearbeitungen im Gitterfeld
if grid.dataProvider().fieldNameIndex('@nodecount') == -1:
    grid.dataProvider().addAttributes([QgsField('@nodecount', QVariant.Int)])
#"agesum": nach Aktualität gewichtete Summe aller Bearbeitungen im Gitterfeld
#"currentness": Aktualität der Daten im Gitterfeld
for attribute in ['@agesum', '@currentness']:
    if grid.dataProvider().fieldNameIndex(attribute) == -1:
        grid.dataProvider().addAttributes([QgsField(attribute, QVariant.Double)])
#für bestimmte, definierte user die Aktivitäten speichern
for user in save_sum_for_user:
    if grid.dataProvider().fieldNameIndex(user) == -1:
        grid.dataProvider().addAttributes([QgsField(user, QVariant.Double)])


grid.updateFields()

#-----------------------------------
#Erste Runde über alle Gitterfelder:
#-----------------------------------
#Für jedes Gitterfeld:
# - Anzahl der Bearbeitungen ermitteln,
# - Bearbeitungen nach Aktualität gewichten,
# - user mit höchster (master) und nach Aktualität gewichtet höchster Aktivität ermitteln
print(time.strftime('%H:%M:%S', time.localtime()), 'Bearbeitungen zählen...')
counter = 0
grid_count = grid.featureCount()
progress = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]
for f in grid.getFeatures():
    counter += 1
    if (counter / grid_count) * 100 >= progress[0]:
        print(time.strftime('%H:%M:%S', time.localtime()), 'Zähle in Feldern: ' + str(progress[0]) + '%.')
        progress.pop(0)

    grid_dict[f.id()] = { '@sum': 0, '@sum_weight': 0 }

    #Gitterfelder einzeln auswählen und Berechnungen nur für im markierten Bereich durchführen
    grid.removeSelection()
    grid.select(f.id())

    #Alle Punkte im Gitterfeld auswählen
    processing.run('native:selectbylocation', { 'INPUT' : nodes, 'INTERSECT' : QgsProcessingFeatureSourceDefinition(grid.id(), selectedFeaturesOnly=True), 'METHOD' : 0, 'PREDICATE' : [6] })

    user_grid_dict = {}

    #Alle Punkte im Gitterfeld durchgehen und Bearbeitungen zählen/nach Alter gewichten
    sum = 0
    sum_weight = 0
    for n in nodes.getSelectedFeatures():
        username = n.attribute('@user')

        #Alter der letzten Bearbeitungs eines Punktes ermitteln
        timestamp = n.attribute('@timestamp')
        timestamp = timestamp.toPyDateTime()
        timestamp = timestamp.date()
        delta = today - timestamp
        age = float(delta.days) / 365.25

        #Gewichtungsfaktor nach Alter bestimmen
        if age < 1:
            age_weight = 1
        elif age < 2:
            age_weight = 0.8
        elif age < 3:
            age_weight = 0.5
        elif age < 4:
            age_weight = 0.2
        elif age < 5:
            age_weight = 0.1
        else:
            age_weight = 0.05

        sum += 1
        sum_weight += age_weight

        #Prüfen, ob user bereits in der Statistik auftaucht und Attribute ergänzen, oder neu anlegen
        #Gitterfeld-Statistik
        if username not in grid_dict[f.id()]:
            grid_dict[f.id()][username] = { 'sum': 0, 'sum_weight': 0, 'sum_weight_activity': 0 }
        #Gesamt-Statistik
        if username not in user_dict:
            user_dict[username] = { 'sum': 0, 'sum_weight': 0, 'grid_sum_max': 0, 'grid_count': 0 }
        #Statistik nur für dieses Gitterfeld
        if username not in user_grid_dict:
            user_grid_dict[username] = { 'sum': 1, 'sum_weight': age_weight }
        else:
            user_grid_dict[username]['sum'] += 1
            user_grid_dict[username]['sum_weight'] += age_weight

    #nach Zählung aller Punkte in einem Gitterfeld:
    user_sum = 0
    grid_sum_max = 0
    grid_sum_weight_max = 0
    master = ''
    activist = ''

    for username in user_grid_dict:
        #Aktivste Bearbeiter eines Gitterfelds speichern...
        user_sum = user_grid_dict[username]['sum']
        user_sum_weight = user_grid_dict[username]['sum_weight']
        if user_sum > grid_sum_max:
            grid_sum_max = user_sum
            master = username
        if user_sum_weight > grid_sum_weight_max:
            grid_sum_weight_max = user_sum_weight
            activist = username

        #... und Bearbeitungen den user- bzw. grid-Statistiken hinzufügen
        user_dict[username]['sum'] += user_sum
        user_dict[username]['sum_weight'] += user_sum_weight
        if user_dict[username]['grid_sum_max'] < user_sum_weight:
            user_dict[username]['grid_sum_max'] = user_sum_weight
#        if user_dict[username]['grid_sum_max'] < user_sum:
#            user_dict[username]['grid_sum_max'] = user_sum
        user_dict[username]['grid_count'] += 1

        grid_dict[f.id()][username]['sum'] = user_sum
        grid_dict[f.id()][username]['sum_weight'] = user_sum_weight

    grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex('@activist'), activist)
    grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex('@master'), master)

    for user in save_sum_for_user:
        if user in grid_dict[f.id()]:
            if save_sum_weight == False:
                grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex(user), grid_dict[f.id()][user]['sum'])
            else:
                grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex(user), grid_dict[f.id()][user]['sum_weight'])
        else:
            grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex(user), 0)

    #Anzahl Nodes und gewichteten Summenwert speichern und daraus Aktualität der Daten ermitteln

    grid_dict[f.id()]['@sum'] = sum
    grid_dict[f.id()]['@sum_weight'] = sum_weight

    grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex('@nodecount'), sum)
    grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex('@agesum'), sum_weight)
    currentness = 0
    if sum > 0:
        currentness = sum_weight / sum
    grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex('@currentness'), currentness)

if activity_weight:
    #------------------------------------
    #zweite Runde über alle Gitterfelder:
    #------------------------------------
    # - Bearbeitungen nach Aktivitätszonen einzelner Mapper gewichten:
    #   lokale Mapper werden in ihren Kerngebieten deutlich stärker gewichtet 
    print(time.strftime('%H:%M:%S', time.localtime()), 'Bearbeitungen gewichten...')

    counter = 0
    progress = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]
    for f in grid.getFeatures():
        counter += 1
        if (counter / grid_count) * 100 >= progress[0]:
            print(time.strftime('%H:%M:%S', time.localtime()), 'Gewichte in Feldern: ' + str(progress[0]) + '%.')
            progress.pop(0)

        #Gitterfelder ohne Aktivitäten überspringen
        if f.id() not in grid_dict:
            continue

        grid.removeSelection()

        #Gitterfeld und Nachbarfelder auswählen
        grid.select(f.id())
        processing.run('native:selectbylocation', { 'INPUT' : grid, 'INTERSECT' : QgsProcessingFeatureSourceDefinition(grid.id(), selectedFeaturesOnly=True), 'METHOD' : 0, 'PREDICATE' : [0] })

        #Gitterfelder mit sehr wenigen OSM-Daten (gering/nicht besiedelt) nicht berücksichtigen
        desert = 0
        for f_sel in grid.getSelectedFeatures():
            if f_sel == f or f_sel.id() not in grid_dict:
                continue
            if grid_dict[f_sel.id()]['@sum'] <= 60:
                desert += 1
        if desert > 2:
            grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex('@localist'), '')
            continue

        #User durchgehen und auf Aktivitätszonen im ausgewählten Bereich prüfen
        for username in grid_dict[f.id()]:
            if username == '@sum' or username == '@sum_weight':
                continue

            #Kern-Aktivitätszone 1: Alle Felder, in denen ein User mehr als 75% seines Gitterfeld-Maximalwerts an Bearbeitungen erreicht (Gewicht + 1)
            #Haupt-Aktivitätszone 2: Alle Felder, in denen ein User mehr als 50% seines Gitterfeld-Maximalwerts an Bearbeitungen erreicht (Gewicht + 0.5)
            sum_zone1 = user_dict[username]['grid_sum_max'] * 0.75
            sum_zone2 = user_dict[username]['grid_sum_max'] * 0.50

            #Nachbarfelder durchgehen und Gewichtungsfaktor erhöhen, wenn diese zu den Kern-Aktivitätszonen des Users gehören...
            #...oder reduzieren, wenn kaum Aktivitäten des users in der Umgebung
            neighbor_activity = 0
            weight = 0 #Startgewicht < 1, damit stärkere Gewichtung nur bei mehreren benachbarten Aktivitätsfelden wirkt
            for f_sel in grid.getSelectedFeatures():
                if f_sel == f or f_sel.id() not in grid_dict:
                    continue
                if username not in grid_dict[f_sel.id()]:
                    continue
                neighbor_activity += 1
                sum = grid_dict[f_sel.id()][username]['sum_weight']
                if sum > sum_zone1:
                    weight += 1 * activity_weight_multiplicator
                elif sum > sum_zone2:
                    weight += 0.5 * activity_weight_multiplicator

            #Gewicht wird nur wirksam, wenn in mehr als 2 Feldern in der Nachbarschaft aktiv
            sum = grid_dict[f.id()][username]['sum_weight']
            if neighbor_activity > 4:
                #Wenn geprüftes Feld selbst Teil einer Aktivitätszone, weiterer Bonus
                if weight > 1:
                    if sum > sum_zone1:
                        weight += 2 * activity_weight_multiplicator
                    elif sum > sum_zone2:
                        weight += 1 * activity_weight_multiplicator
                    sum = sum * weight
                grid_dict[f.id()][username]['sum_weight_activity'] = sum
            #bei nur geringer Aktivität in der Nachbarschaft weniger gewichten
            else:
                grid_dict[f.id()][username]['sum_weight_activity'] = sum * (0.2 * neighbor_activity)

        localist = ''
        sum_localist = 0
        for username in grid_dict[f.id()]:
            if username == '@sum' or username == '@sum_weight':
                continue
            sum = grid_dict[f.id()][username]['sum_weight_activity']
            if sum > sum_localist:
                sum_localist = sum
                localist = username

        grid.changeAttributeValue(f.id(), grid.dataProvider().fieldNameIndex('@localist'), localist)

    #zusammenhängende Felder vereinigen
    print(time.strftime('%H:%M:%S', time.localtime()), 'Erstelle localist-Karte.')
    grid_dissolved = processing.run('native:dissolve', { 'INPUT' : grid, 'FIELD' : ['@localist'], 'OUTPUT': 'memory:'})['OUTPUT']
    grid_dissolved_singlepart = processing.run('native:multiparttosingleparts', { 'INPUT' : grid_dissolved, 'OUTPUT': 'memory:'})['OUTPUT']
    QgsProject.instance().addMapLayer(grid_dissolved_singlepart, True)

grid.removeSelection()
nodes.removeSelection()

grid.commitChanges()

if write_user_stat:
    print(time.strftime('%H:%M:%S', time.localtime()), 'Schreibe user-Daten in CSV.')
    with open(write_user_stat_path, mode = 'w') as file:
        writer = csv.writer(file, delimiter=',', quotechar='"', quoting=csv.QUOTE_MINIMAL)
        writer.writerow(['username', 'edit_count', 'edits_current', 'grid_count', 'localist_count', 'activist_count', 'master_count'])
        for username in user_dict:
            localist_count = activist_count = master_count = 0
            for f in grid.getFeatures():
                if f.attribute('@localist') == username:
                    localist_count += 1
                if f.attribute('@activist') == username:
                    activist_count += 1
                if f.attribute('@master') == username:
                    master_count += 1
            writer.writerow([username, user_dict[username]['sum'], user_dict[username]['sum_weight'], user_dict[username]['grid_count'], localist_count, activist_count, master_count])

print(time.strftime('%H:%M:%S', time.localtime()), 'Abgeschlossen.')
