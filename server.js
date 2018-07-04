const logger = require('morgan'),
    cors = require('cors'),
    http = require('http'),
    express = require('express'),
    bodyParser = require('body-parser'),
    uuid = require('uuid'),
    AWS = require('aws-sdk'),
    fs = require('fs'),
    admin = require('firebase-admin'),
    base64 = require('base-64');

const serviceAccount = require("./config/dot-reg-firebase-admin.json");

let firebaseData;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://dot-reg.firebaseio.com",
  databaseAuthVariableOverride: {
      uid: "AIzaSyBVtu9ApJsveL_J4MliEhH5-4yxUT5DgIA"
  }
});

const db = admin.database();
const ref = db.ref("/tickets");
ref.on("value", function(snapshot) {
  firebaseData = snapshot.val();
  console.log(firebaseData); 
});

AWS.config.apiVersions = {
    rekognition: '2016-06-27',
    s3: '2006-03-01'
};

AWS.config.loadFromPath('./config/config.json');

const collectionId = 'meeting-checkin';
const faceMatchThreshold = 70; //Limiar de similaridade, usada para buscar as faces na collection
const bucketName = 'meeting-checkin';
const dirFile = 'C:\\Temp\\';

const S3 = new AWS.S3();
const rekognition = new AWS.Rekognition();
const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());

if (process.env.NODE_ENV === 'development') {
    app.use(express.logger('dev'));
    app.use(errorhandler());
}

const port = process.env.PORT || 3000;

app.get('/bucketExists/:name', (req, res) => {
    bucketExists(req.params.name).then(data => {
        res.status(200).send({
            result: data === true ? 'S' : 'N'
        });
    });
});

app.post('/arduinoUpload', (req, res) => {
    var f = fs.createWriteStream(dirFile + 'out.jpg', { autoClose: true });

    let length = Number(req.headers["content-length"]);
    //let buffer = Buffer.alloc(length, 0, "binary");    
    req.on('data', data => {
        if (data) {
            f.write(data);
            /*let buff = Buffer.from(data);
            buffer = Buffer.concat([buffer, buff]);
            offset = data.toString().length;*/
        }
    });
    req.on('end', () => {

        f.end(() => {
            let buffer = fs.readFileSync(dirFile + 'out.jpg');
            compareFaces(buffer).then(recognized => {
                if (recognized) {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('ACCEPTED: ' + id + '\n');
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('REJECTED\n');
                }
            });
        });
    })
});

app.post('/putImageToBucket', (req, res) => {
    let result;
    let buffer = '';
    req.on('data', data => {
        buffer += data;
    });
    req.on('end', body => {
        body = JSON.parse(buffer);
        let image = body.image;
        let userId = body.userId;
        let data = new Buffer(image.toString().substr(22), 'base64');
        putFaceToBucket({ userId: userId, file: data }).then((data) => {
            if (data) {
                result = { result: "Arquivo hospedado!" };
                putFaceToCollection(userId);
            } else {
                result = { result: "Não foi possível concluir o processo!" };
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        }, (reason) => {
            console.log(reason);
        });
    });
});

app.post('/deleteImageByUser', (req, res) => {

})

app.get('/getImageByUser', (req, res) => {
    let input = '';
    req.on('data', data => {
        input += data;
    })
    req.on('end', () => {
        let body = req.query;
        let images = [];
        getImageFromAmazon(body.userId + "_0.jpg").then(image1 => {
            images.push(image1);
            getImageFromAmazon(body.userId + "_1.jpg").then(image2 => {
                images.push(image2);
                getImageFromAmazon(body.userId + "_2.jpg").then(image3 => {
                    images.push(image3);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.write(JSON.stringify({images: images}));
                });
            });
        });
    })
})

app.post('/searchImage', (req, res) => {
    req.on('data', body => {
        body = JSON.parse(body);
        let image = new Buffer(body.image.toString().substr(22), 'base64');
        compareFaces(image).then(data => {
            if (data) {
                res.end(data);
            }
        })
    })
});

http.createServer(app).listen(port, function (err) {
    console.log('listening in http://localhost:' + port);
    createCollection();    
});

function getImageFromAmazon(userId) {
    var params = {
        Bucket: bucketName,
        Key: userId,
        ResponseContentEncoding: "base64"
    };
    return S3.getObject(params).promise().then(response => {
        return response.Body.toString('base64');
    })
}

function compareFaces(data) {
    var params = {
        CollectionId: collectionId,
        Image: {
            Bytes: data
            /*S3Object: {
              Bucket: bucketName,
              Name: data
            }*/
        },
        FaceMatchThreshold: faceMatchThreshold,
        MaxFaces: 1 //Quantidade de faces que será retornada
    };

    return rekognition.searchFacesByImage(params).promise().then(data => {
        if (data.FaceMatches.length) {
            var face = data.FaceMatches[0];
            console.log("Face encontrada: " + face.Face.ExternalImageId);
            console.log("Com semelhança de: " + face.Similarity);
            if (face.Similarity > 80) {
                return validateSession(face.Face.ExternalImageId);
            } else {
                return false;
            }
        } else {
            console.log("Não foram encontradas faces");
            return false;
        }
    }, error => {
        console.log("Erro ao buscar face: " + error.message);
        return false;
    });
}

function putFaceToCollection(face) {
    let input = {
        CollectionId: collectionId,
        Image: {
            //Bytes: new Buffer(base64Img) <- usar este parâmetro caso queira indexar uma imagem em base64, tamanho máximo 5mb
            S3Object: {
                Bucket: bucketName,
                Name: face + ".jpg"
            }
        },
        DetectionAttributes: ["ALL"],
        ExternalImageId: face
    };

    return rekognition.indexFaces(input).promise().then(data => {
        console.log("Face indexada com sucesso!")
        console.log(data);
        return true;
    }, err => {
        console.log("Erro ao indexar face: " + err.message);
        return false;
    });
}

/**
 * Cria uma coleção para armazenar as faces.
 * Caso ja exista uma coleção com este id retorna um erro.
 */
function createCollection() {
    rekognition.createCollection({ CollectionId: collectionId }, (err, data) => {
        if (err) {
            console.log("Erro ao criar coleção: " + err.message);
        } else {
            console.log("Coleção criada com sucesso.")
            console.log(data);
        }
    });
}

function deleteCollection() {
    return rekognition.deleteCollection({CollectionId: collectionId}).promise();
}

function validateSession(id) {
    id = id.substr(0, id.length-2);
    for (let key in firebaseData) {
        if (firebaseData[key].uid == id) {
            ref.child(key).set(null);
            return true;
        }
    }
    return false
}

function putFaceToBucket(param) {
    return S3.putObject({
        Bucket: bucketName,
        Key: param.userId + ".jpg",
        Body: param.file,
        ContentEncoding: 'binary',
        ContentType: 'image/jpg'
    }).promise().then(() => {
        return true;
    }, () => {
        return false;
    });
}

function bucketExists(name) {
    return S3.listBuckets().promise().then(data => {
        return data.Buckets.some((bucket => {
            return bucket.Name === name;
        }));
    });
}