# Big Five Shot Predictor

A machine learning model that predicts the full distribution of shots for every team,
in every match of Europe's top five leagues (Premier League, La Liga, Serie A,
Bundesliga, Ligue 1).

Open a match to see each team's forecast: the bars are the chance of each exact number
of shots, the black bar is the real one. Drag the slider to set a line and read the
chance of going over or under it.

## About the model

Trained on ten seasons (2015/16 to 2025/26) of the five leagues, from each team's recent
shots, expected goals and possession, what its opponent usually concedes, and the
pre-match odds. The model gives the expected number of shots; a negative binomial
distribution turns it into a probability for every count.

